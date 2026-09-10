"""生成 cmdc-hub 图标 — 蓝紫渐变圆角方块 + 白色 ⌘ 符号"""
from PIL import Image, ImageDraw, ImageFont
import math

SIZE = 256
RADIUS = 56

# 创建透明画布
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# 蓝紫渐变背景
for y in range(SIZE):
    t = y / SIZE
    # 顶部 #6366f1 靛蓝 → 底部 #8b5cf6 紫色
    r = int(99 + (139 - 99) * t)
    g = int(102 + (92 - 102) * t)
    b = int(241 + (246 - 241) * t)
    for x in range(SIZE):
        # 圆角裁切
        dx, dy = 0, 0
        if x < RADIUS and y < RADIUS:
            dx, dy = RADIUS - x, RADIUS - y
        elif x >= SIZE - RADIUS and y < RADIUS:
            dx, dy = x - (SIZE - RADIUS - 1), RADIUS - y
        elif x < RADIUS and y >= SIZE - RADIUS:
            dx, dy = RADIUS - x, y - (SIZE - RADIUS - 1)
        elif x >= SIZE - RADIUS and y >= SIZE - RADIUS:
            dx, dy = x - (SIZE - RADIUS - 1), y - (SIZE - RADIUS - 1)
        if dx > 0 and dy > 0:
            dist = math.hypot(dx, dy)
            if dist > RADIUS:
                continue
            # 抗锯齿边缘
            if dist > RADIUS - 1:
                alpha = int((RADIUS - dist) * 255)
                img.putpixel((x, y), (r, g, b, alpha))
                continue
        img.putpixel((x, y), (r, g, b, 255))

draw = ImageDraw.Draw(img)

# 用大号字体渲染 ⌘ (U+2318)
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 140)
# 找字符的包围盒
bbox = draw.textbbox((0, 0), '\u2318', font=font)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
x = (SIZE - tw) / 2 - bbox[0]
y = (SIZE - th) / 2 - bbox[1] - 6
draw.text((x, y), '\u2318', fill='white', font=font)

# 右下小箭头表示"代理/中转"
arrow_font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 48)
draw.text((170, 165), '\u21c4', fill=(255, 255, 255, 230), font=arrow_font)

img.save('/home/cyc/.local/share/icons/cmdc-hub.png')
print('icon saved')
