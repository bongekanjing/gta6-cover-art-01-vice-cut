# Screenshot limits — must fix before submit

RULES.txt line 23, verbatim:

> screenshots/ holds 3 to 4 images ... at most 256 KiB, a whole PNG or JPEG, its long side
> at most 1280 and its short side at least 480 pixels. So a 1080 x 1350 cover is shown at
> most 1024 x 1280, and a 1920 x 1080 one at most 1280 x 720.

Current files violate the long-side cap:

    screenshots/2-editor.jpg     1440 x 900     over 1280
    screenshots/3-triptych.jpg   1080 x 1350    over 1280 (tall side is the long side)
    screenshots/4-wide.jpg       1920 x 1080    over 1280

Only 1-cover.jpg (1080 x 1080) passes.

Fix: re-export each at or under 1280 on the long side, keeping the short side >= 480:

    2-editor : 1440 x 900   -> 1280 x 800
    3-triptych: 1080 x 1350 -> 1024 x 1280
    4-wide   : 1920 x 1080  -> 1280 x 720

Keep each under 256 KiB. Downscaling an existing render is fine; do not composite or edit
the art itself. The 1080 x 1350 cover is explicitly allowed to be shown at 1024 x 1280, so
shrinking is the expected treatment, not a compromise.

Verify with:

    python3 -c "
from PIL import Image; import os
for f in sorted(os.listdir('screenshots')):
    p='screenshots/'+f; w,h=Image.open(p).size
    print(f, w, h, os.path.getsize(p), 'OK' if max(w,h)<=1280 and min(w,h)>=480 and os.path.getsize(p)<=262144 else 'FAIL')"
