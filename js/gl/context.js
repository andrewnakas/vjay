// WebGL2 core: context init, shader compilation with a shared fragment header,
// framebuffers, ping-pong buffers, and a fullscreen-triangle draw.

export function initGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true, // needed for captureStream / screenshots
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');

  // Half-float render targets make feedback trails smooth instead of banded.
  gl.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');

  // One big triangle covering the viewport - cheaper than a quad, no seam.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.__quadVao = vao;

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  return gl;
}

const VS_SRC = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

function compileStage(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    // Print the offending lines with numbers - GLSL errors are useless without them.
    const numbered = src.split('\n').map((l, i) => String(i + 1).padStart(4) + ' | ' + l).join('\n');
    console.error(`[shader:${label}] compile failed\n${log}\n${numbered}`);
    gl.deleteShader(sh);
    throw new Error(`Shader "${label}" failed to compile: ${log}`);
  }
  return sh;
}

/** A compiled program plus a uniform cache that dispatches on the declared GLSL type. */
export class Shader {
  constructor(gl, fragSrc, label = 'shader') {
    this.gl = gl;
    this.label = label;
    const vs = compileStage(gl, gl.VERTEX_SHADER, VS_SRC, label + ':vs');
    const fs = compileStage(gl, gl.FRAGMENT_SHADER, fragSrc, label + ':fs');
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      console.error(`[shader:${label}] link failed\n${log}`);
      throw new Error(`Shader "${label}" failed to link: ${log}`);
    }
    this.program = p;
    this.uniforms = Object.create(null);
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms[name] = { loc: gl.getUniformLocation(p, name), type: info.type, size: info.size };
    }
    this._unit = 0;
  }

  use() {
    this.gl.useProgram(this.program);
    this._unit = 0;
    return this;
  }

  /** Silently ignores names the shader does not declare, so callers can spray uniforms. */
  set(name, value) {
    const u = this.uniforms[name];
    if (!u) return this;
    const gl = this.gl;
    switch (u.type) {
      case gl.FLOAT:
        if (u.size > 1 || Array.isArray(value) || ArrayBuffer.isView(value)) gl.uniform1fv(u.loc, value);
        else gl.uniform1f(u.loc, value);
        break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, value); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, value); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, value); break;
      case gl.INT:
      case gl.BOOL:
        if (u.size > 1 || Array.isArray(value)) gl.uniform1iv(u.loc, value);
        else gl.uniform1i(u.loc, value | 0);
        break;
      case gl.INT_VEC2: gl.uniform2iv(u.loc, value); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, value); break;
      case gl.SAMPLER_2D: gl.uniform1i(u.loc, value | 0); break;
      default: break;
    }
    return this;
  }

  setAll(obj) {
    for (const k in obj) this.set(k, obj[k]);
    return this;
  }

  /** Binds a texture to the next free unit and points the sampler at it. */
  tex(name, texture) {
    const u = this.uniforms[name];
    if (!u || !texture) return this;
    const gl = this.gl;
    const unit = this._unit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(u.loc, unit);
    return this;
  }

  draw() {
    const gl = this.gl;
    gl.bindVertexArray(gl.__quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this;
  }

  dispose() { this.gl.deleteProgram(this.program); }
}

export function createTexture(gl, { filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return t;
}

/** Off-screen render target. Half-float when supported so trails do not band. */
export class FBO {
  constructor(gl, w, h, { wrap } = {}) {
    this.gl = gl;
    this.wrapMode = wrap || gl.CLAMP_TO_EDGE;
    this.texture = createTexture(gl, { wrap: this.wrapMode });
    this.fbo = gl.createFramebuffer();
    this.width = 0;
    this.height = 0;
    this.resize(w, h);
  }

  resize(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.width && h === this.height) return this;
    const gl = this.gl;
    this.width = w;
    this.height = h;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (gl.floatTargets) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this;
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    return this;
  }

  clear(r = 0, g = 0, b = 0, a = 1) {
    const gl = this.gl;
    this.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return this;
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

/** Two FBOs you bounce between - the backbone of the effect chain. */
export class PingPong {
  constructor(gl, w, h) {
    this.a = new FBO(gl, w, h);
    this.b = new FBO(gl, w, h);
  }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  resize(w, h) { this.a.resize(w, h); this.b.resize(w, h); return this; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/** Render to the default framebuffer (the visible canvas). */
export function bindScreen(gl, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
}
