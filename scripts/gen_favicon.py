"""生成 HR 工作台 favicon 套件：
蓝底渐变圆角方块 + 白色 "HR"（与登录页 logo 同款视觉）。
输出到 public/：favicon.svg 已手写，本脚本生成 PNG + ICO。"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 512
TOP = (30, 64, 175)      # #1e40af
BOTTOM = (37, 99, 235)   # #2563eb
RADIUS = 110

# 1) 垂直渐变底（上深下亮，呼应品牌渐变）
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
    g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
    b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
    d.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

# 2) 圆角遮罩（圆角外透明）
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
img.putalpha(mask)

# 3) 白色 "HR" 粗体居中
font_path = None
for p in ("C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf"):
    if os.path.exists(p):
        font_path = p
        break
font = ImageFont.truetype(font_path, 245)
d = ImageDraw.Draw(img)
d.text((SIZE / 2, SIZE / 2), "HR", font=font, fill=(255, 255, 255, 255), anchor="mm")

# 4) 输出
img.save("public/apple-touch-icon.png")
img.resize((32, 32), Image.LANCZOS).save("public/favicon-32x32.png")
img.resize((16, 16), Image.LANCZOS).save("public/favicon-16x16.png")
img.save("public/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("OK, ico =", os.path.getsize("public/favicon.ico"), "bytes")
