// Kinect v1 -> v4l2loopback bridge for VJay.
//
// A Kinect is not a UVC device, so Chrome cannot see it. This reads the sensor
// with libfreenect and writes plain frames into v4l2loopback devices, which do
// appear to Chrome as ordinary cameras.
//
//   build: gcc -O2 -o kinect-pump kinect-pump.c -lfreenect -lm
//   run:   ./kinect-pump --video /dev/video10 --depth /dev/video11
//
// Note: on a Kinect v1 the colour and IR streams share one camera, so you get
#include <errno.h>
// RGB *or* IR, never both. Depth runs alongside either.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <linux/videodev2.h>
#include <libfreenect/libfreenect.h>

static freenect_context *f_ctx;
static freenect_device  *f_dev;
static int video_fd = -1, depth_fd = -1;
static volatile int running = 1;

static int   use_ir     = 0;
static float depth_near = 500.0f;    // mm
static float depth_far  = 4000.0f;   // mm

static unsigned char *yuyv_video, *yuyv_depth;
static int vw, vh, dw, dh;

static void on_signal(int sig) { (void)sig; running = 0; }

/** Configure a v4l2loopback node for YUYV output at the given size. */
static int open_loopback(const char *path, int w, int h) {
    int fd = open(path, O_RDWR);
    if (fd < 0) { fprintf(stderr, "open %s: %s\n", path, strerror(errno)); return -1; }
    struct v4l2_format fmt;
    memset(&fmt, 0, sizeof fmt);
    fmt.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
    fmt.fmt.pix.width       = w;
    fmt.fmt.pix.height      = h;
    fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_YUYV;
    fmt.fmt.pix.field       = V4L2_FIELD_NONE;
    fmt.fmt.pix.bytesperline= w * 2;
    fmt.fmt.pix.sizeimage   = w * h * 2;
    fmt.fmt.pix.colorspace  = V4L2_COLORSPACE_SRGB;
    if (ioctl(fd, VIDIOC_S_FMT, &fmt) < 0) {
        fprintf(stderr, "VIDIOC_S_FMT %s: %s\n", path, strerror(errno));
        close(fd);
        return -1;
    }
    fprintf(stderr, "  %s <- %dx%d YUYV\n", path, w, h);
    return fd;
}

static inline unsigned char clamp8(int v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

/** RGB24 -> YUYV. Chrome accepts YUYV from every V4L2 source; RGB24 it may not. */
static void rgb_to_yuyv(const unsigned char *rgb, unsigned char *out, int w, int h) {
    for (int i = 0; i < w * h; i += 2) {
        const unsigned char *p0 = rgb + i * 3;
        const unsigned char *p1 = rgb + (i + 1) * 3;
        int y0 = ( 66 * p0[0] + 129 * p0[1] +  25 * p0[2] + 128) / 256 + 16;
        int y1 = ( 66 * p1[0] + 129 * p1[1] +  25 * p1[2] + 128) / 256 + 16;
        int u  = (-38 * p0[0] -  74 * p0[1] + 112 * p0[2] + 128) / 256 + 128;
        int v  = (112 * p0[0] -  94 * p0[1] -  18 * p0[2] + 128) / 256 + 128;
        out[i * 2 + 0] = clamp8(y0);
        out[i * 2 + 1] = clamp8(u);
        out[i * 2 + 2] = clamp8(y1);
        out[i * 2 + 3] = clamp8(v);
    }
}

/** 8-bit grey -> YUYV with neutral chroma. */
static void grey_to_yuyv(const unsigned char *grey, unsigned char *out, int w, int h) {
    for (int i = 0; i < w * h; i += 2) {
        out[i * 2 + 0] = grey[i];
        out[i * 2 + 1] = 128;
        out[i * 2 + 2] = grey[i + 1];
        out[i * 2 + 3] = 128;
    }
}

static void video_cb(freenect_device *dev, void *data, uint32_t ts) {
    (void)dev; (void)ts;
    if (video_fd < 0) return;
    if (use_ir) grey_to_yuyv((unsigned char *)data, yuyv_video, vw, vh);
    else        rgb_to_yuyv((unsigned char *)data, yuyv_video, vw, vh);
    ssize_t n = write(video_fd, yuyv_video, (size_t)vw * vh * 2);
    (void)n;
}

static void depth_cb(freenect_device *dev, void *data, uint32_t ts) {
    (void)dev; (void)ts;
    if (depth_fd < 0) return;
    uint16_t *mm = (uint16_t *)data;
    static unsigned char *grey = NULL;
    if (!grey) grey = malloc((size_t)dw * dh);
    float span = depth_far - depth_near;
    for (int i = 0; i < dw * dh; i++) {
        uint16_t d = mm[i];
        // 0 means "no reading" (shadow, too close, too reflective). Map it to
        // full white so a near-range depth key treats it as background.
        if (d == 0) { grey[i] = 255; continue; }
        float t = ((float)d - depth_near) / span;
        int v = (int)(t * 255.0f + 0.5f);
        grey[i] = (unsigned char)(v < 1 ? 1 : (v > 255 ? 255 : v));
    }
    grey_to_yuyv(grey, yuyv_depth, dw, dh);
    ssize_t n = write(depth_fd, yuyv_depth, (size_t)dw * dh * 2);
    (void)n;
}

int main(int argc, char **argv) {
    const char *video_path = "/dev/video10";
    const char *depth_path = "/dev/video11";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--video") && i + 1 < argc) video_path = argv[++i];
        else if (!strcmp(argv[i], "--depth") && i + 1 < argc) depth_path = argv[++i];
        else if (!strcmp(argv[i], "--ir")) use_ir = 1;
        else if (!strcmp(argv[i], "--near") && i + 1 < argc) depth_near = atof(argv[++i]);
        else if (!strcmp(argv[i], "--far")  && i + 1 < argc) depth_far  = atof(argv[++i]);
        else if (!strcmp(argv[i], "--help")) {
            printf("usage: %s [--video /dev/videoN] [--depth /dev/videoN] [--ir]\n"
                   "          [--near MM] [--far MM]\n", argv[0]);
            return 0;
        }
    }

    if (freenect_init(&f_ctx, NULL) < 0) { fprintf(stderr, "freenect_init failed\n"); return 1; }
    freenect_set_log_level(f_ctx, FREENECT_LOG_WARNING);
    freenect_select_subdevices(f_ctx, FREENECT_DEVICE_CAMERA);

    int n = freenect_num_devices(f_ctx);
    if (n < 1) {
        fprintf(stderr, "No Kinect found. Check the 12V power adapter is connected -\n"
                        "the sensor enumerates but will not stream without it.\n");
        freenect_shutdown(f_ctx);
        return 1;
    }
    if (freenect_open_device(f_ctx, &f_dev, 0) < 0) {
        fprintf(stderr, "Could not open device 0 (permissions? try the udev rules from the freenect package)\n");
        freenect_shutdown(f_ctx);
        return 1;
    }

    freenect_frame_mode vm = freenect_find_video_mode(
        FREENECT_RESOLUTION_MEDIUM, use_ir ? FREENECT_VIDEO_IR_8BIT : FREENECT_VIDEO_RGB);
    // REGISTERED aligns depth to the colour camera, so a depth matte lines up
    // with the RGB image it is masking instead of sitting a few centimetres off.
    freenect_frame_mode dm = freenect_find_depth_mode(
        FREENECT_RESOLUTION_MEDIUM, FREENECT_DEPTH_REGISTERED);
    if (!vm.is_valid || !dm.is_valid) { fprintf(stderr, "invalid mode\n"); return 1; }

    vw = vm.width; vh = vm.height;
    dw = dm.width; dh = dm.height;
    fprintf(stderr, "Kinect v1: %s %dx%d, depth %dx%d (%.0f-%.0fmm)\n",
            use_ir ? "IR" : "RGB", vw, vh, dw, dh, depth_near, depth_far);

    yuyv_video = malloc((size_t)vw * vh * 2);
    yuyv_depth = malloc((size_t)dw * dh * 2);

    video_fd = open_loopback(video_path, vw, vh);
    depth_fd = open_loopback(depth_path, dw, dh);
    if (video_fd < 0 && depth_fd < 0) return 1;

    freenect_set_video_mode(f_dev, vm);
    freenect_set_depth_mode(f_dev, dm);
    freenect_set_video_callback(f_dev, video_cb);
    freenect_set_depth_callback(f_dev, depth_cb);
    freenect_start_video(f_dev);
    freenect_start_depth(f_dev);

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    fprintf(stderr, "streaming - Ctrl+C to stop\n");
    while (running && freenect_process_events(f_ctx) >= 0) { }

    freenect_stop_depth(f_dev);
    freenect_stop_video(f_dev);
    freenect_close_device(f_dev);
    freenect_shutdown(f_ctx);
    if (video_fd >= 0) close(video_fd);
    if (depth_fd >= 0) close(depth_fd);
    return 0;
}
