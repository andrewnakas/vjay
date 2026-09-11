#!/usr/bin/env bash
# Bring up a Kinect v1 as two ordinary cameras that Chrome (and so VJay) can see.
#
#   ./tools/kinect.sh          RGB + depth
#   ./tools/kinect.sh --ir     IR  + depth
set -e
cd "$(dirname "$0")"

if ! modinfo v4l2loopback >/dev/null 2>&1; then
  echo "v4l2loopback is not installed. Run:"
  echo "  sudo apt-get install -y v4l2loopback-dkms freenect libfreenect-dev v4l-utils"
  exit 1
fi

# exclusive_caps=1 is what makes Chrome treat the node as a capture device.
if [ ! -e /dev/video10 ]; then
  echo "Loading v4l2loopback (needs sudo)..."
  sudo modprobe -r v4l2loopback 2>/dev/null || true
  sudo modprobe v4l2loopback devices=2 video_nr=10,11 \
    card_label="Kinect Colour","Kinect Depth" exclusive_caps=1,1
fi

if [ ! -x ./kinect-pump ] || [ kinect-pump.c -nt kinect-pump ]; then
  echo "Building kinect-pump..."
  gcc -O2 -o kinect-pump kinect-pump.c -lfreenect -lm
fi

echo
echo "Virtual cameras:"
v4l2-ctl --list-devices 2>/dev/null | grep -A2 -i kinect || ls -l /dev/video10 /dev/video11
echo
echo "Open:  http://localhost:8080/?cams=all"
echo
exec ./kinect-pump --video /dev/video10 --depth /dev/video11 "$@"
