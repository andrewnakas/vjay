// Desktop shell for VJay.
//
// The app itself is unchanged web code. This process exists to give it the
// three things a browser tab will not: screen capture without a picker that
// forgets itself, a real second window on the projector, and camera and MIDI
// permission that is granted once instead of per session.
//
// It is served over 127.0.0.1 rather than file://. Two reasons, both load
// bearing: ES modules are blocked by CORS on file://, and getUserMedia,
// getDisplayMedia and WebMIDI all need a secure context, which localhost is and
// file:// is not. It also means the packaged app runs the exact same way as
// `./serve.sh` during development, which is worth more than saving a port.

const { app, BrowserWindow, session, desktopCapturer, shell, screen } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const ROOT = path.join(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

/**
 * Serve the app directory on a loopback port the OS picks for us.
 * @returns the origin, e.g. http://127.0.0.1:49213
 */
function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      // Resolve inside ROOT and prove it stayed there. The server is bound to
      // loopback, but a path that escapes the app directory is not something to
      // leave to the binding.
      const file = path.resolve(ROOT, rel);
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // Same reasoning as serve.sh: a half-cached ES module graph fails in
        // ways that look like application bugs.
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(e.code === 'ENOENT' ? 404 : 500).end(String(e.code || e.message));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/**
 * Screen capture. Electron hands the choice to us rather than showing a picker,
 * so pick the whole screen the window is NOT on when there is one - which on a
 * projector rig is the projector - and the current screen otherwise.
 *
 * Deliberately not a window: a window that goes behind another one stops being
 * repainted by the compositor and its capture freezes on the last frame, which
 * is exactly the failure the in-app Inputs panel had to learn to explain.
 */
function wireDisplayCapture(ses) {
  if (!ses.setDisplayMediaRequestHandler) return;
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) { callback({}); return; }
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      // desktopCapturer ids carry the display id on every platform we ship.
      const other = displays.find((d) => d.id !== primary.id);
      const wanted = other && sources.find((s) => String(s.display_id) === String(other.id));
      callback({ video: wanted || sources[0] });
    } catch (_) {
      callback({});
    }
  }, { useSystemPicker: true });
}

function createWindow(origin) {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#07080c',
    title: 'VJay',
    icon: process.platform === 'linux' ? path.join(ROOT, 'build', 'icon.png') : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,   // a minimised window must keep projecting
    },
  });

  // The output pop-out. The app calls window.open and then writes a <video>
  // into that document, so it has to be a real same-origin window rather than a
  // tab handed to the system browser. Everything else opens outside the app.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === 'vjay-output' || url === 'about:blank' || url.startsWith(origin)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1280,
          height: 800,
          backgroundColor: '#000000',
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(`${origin}/index.html`);
  return win;
}

app.whenReady().then(async () => {
  const origin = await serve();
  const ses = session.defaultSession;

  // Camera, microphone, MIDI and window placement, granted for our own origin.
  // The app asks for each only when you pick a source; this stops the desktop
  // build asking a second time on top of that.
  const ALLOW = new Set(['media', 'audioCapture', 'videoCapture', 'display-capture',
    'midi', 'midiSysex', 'window-management', 'fullscreen', 'pointerLock']);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(ALLOW.has(permission) && (wc.getURL() || '').startsWith(origin));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => (
    ALLOW.has(permission) && (requestingOrigin || '').startsWith(origin)
  ));

  wireDisplayCapture(ses);
  createWindow(origin);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(origin);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
