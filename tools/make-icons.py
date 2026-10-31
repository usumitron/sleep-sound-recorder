"""
アイコン・起動画面の画像を res/ に書き出す（元データは make-icons.js で作る tools/app-icon*-1024.png）。

- iOS のアイコン: App Store はアルファチャンネルのある画像を受け付けないため、RGB で書き出す
- Android: 従来のアイコン（src）と、アダプティブアイコンの前景・背景（108dp）
- 起動画面: iOS は藍色の無地、Android 12 以降はアイコンを透明にして藍色の無地にする（起動画面なしに見せる）

使い方: python tools/make-icons.py
"""
import os
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
TOOLS = os.path.join(ROOT, 'tools')
NIGHT = (0x1A, 0x21, 0x38)  # アプリの背景色（config.xml の BackgroundColor と同じ）


def src(name, mode):
    return Image.open(os.path.join(TOOLS, name)).convert(mode)


def save(img, rel, size=None):
    if size:
        img = img.resize((size, size), Image.LANCZOS)
    out = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, optimize=True)
    print('saved', rel, img.size, img.mode)


full = src('app-icon-1024.png', 'RGB')
fg = src('app-icon-foreground-1024.png', 'RGBA')
bg = src('app-icon-background-1024.png', 'RGB')

# iOS（config.xml に書かれているファイルすべて）
IOS = {
    'icon-1024.png': 1024, 'icon.png': 57, 'icon@2x.png': 114, 'icon-72.png': 72, 'icon-72@2x.png': 144,
    'icon-60.png': 60, 'icon-60@2x.png': 120, 'icon-60@3x.png': 180, 'icon-76.png': 76, 'icon-76@2x.png': 152,
    'icon-83.5@2x~ipad.png': 167, 'icon-20.png': 20, 'icon-20@2x.png': 40, 'icon-40.png': 40, 'icon-40@2x.png': 80,
    'icon-50.png': 50, 'icon-50@2x.png': 100, 'icon-small.png': 29, 'icon-small@2x.png': 58, 'icon-small@3x.png': 87,
}
for name, size in IOS.items():
    save(full, 'res/ios/icon/' + name, size)

# Android（従来のアイコンは 48dp、アダプティブアイコンの各レイヤーは 108dp）
SCALE = {'ldpi': 0.75, 'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for d, s in SCALE.items():
    save(full, 'res/android/icon/%s.png' % d, round(48 * s))
    save(fg, 'res/android/icon/%s-foreground.png' % d, round(108 * s))
    save(bg, 'res/android/icon/%s-background.png' % d, round(108 * s))

# 起動画面
save(Image.new('RGB', (2732, 2732), NIGHT), 'res/ios/screen/Default@2x~universal~anyany.png')
save(Image.new('RGBA', (288, 288), (0, 0, 0, 0)), 'res/android/screen/splash-blank.png')
