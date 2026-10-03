#!/bin/bash
# 重新產生吉祥物圖示並編譯 DingDong.app。
# 需要 node，以及 macOS 內建的 osacompile、sips、iconutil、plutil、codesign。
set -euo pipefail
cd "$(dirname "$0")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

node make-icon.mjs mascot.png

mkdir "$WORK/mascot.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" mascot.png --out "$WORK/mascot.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" mascot.png --out "$WORK/mascot.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/mascot.iconset" -o "$WORK/mascot.icns"

rm -rf DingDong.app
osacompile -o DingDong.app notify.applescript

# 換上吉祥物圖示；Assets.car 和 CFBundleIconName 會蓋過 applet.icns，所以要拿掉
cp "$WORK/mascot.icns" DingDong.app/Contents/Resources/applet.icns
rm -f DingDong.app/Contents/Resources/Assets.car
plutil -remove CFBundleIconName DingDong.app/Contents/Info.plist 2>/dev/null || true
plutil -replace CFBundleIdentifier -string "local.ding-dong.notifier" DingDong.app/Contents/Info.plist
plutil -replace CFBundleName -string "叮咚" DingDong.app/Contents/Info.plist
# 不在 Dock 顯示圖示
plutil -replace LSUIElement -bool true DingDong.app/Contents/Info.plist

# 改過內容後簽章會失效，要在本機重簽才能執行
codesign --force --deep -s - DingDong.app

echo "已建立 $(pwd)/DingDong.app"
