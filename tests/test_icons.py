"""The item icon renderer, driven by a synthetic jar.

build_assets.py reimplements Minecraft's item-model pipeline, and until now nothing
exercised it: the real client jar comes from Mojang, so the only way to see its
output was to deploy. Assets is a thin zipfile wrapper, so a handful of hand-written
models over solid-colour textures pins the behaviour down here instead.

Solid colours are the point — "which face was drawn, and how bright" is then just a
pixel lookup.
"""

import importlib.util
import io
import json
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image

# Loading by file path will happily reuse a stale .pyc from an earlier edit,
# which makes a fixed module look broken. Don't leave one behind.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("build_assets", HERE.parent / "site" / "build_assets.py")
ba = importlib.util.module_from_spec(spec)
sys.modules["build_assets"] = ba
spec.loader.exec_module(ba)

# distinct per face, so a pixel says which face it came from
RED, GREEN, BLUE = (220, 40, 40), (40, 200, 40), (40, 80, 230)
WHITE, YELLOW = (240, 240, 240), (230, 220, 60)


def png(colour, size=16):
    image = Image.new("RGBA", (size, size), (*colour, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def cube_faces(texture="#all"):
    return {name: {"texture": texture} for name in
            ("up", "down", "north", "south", "east", "west")}


def build_jar(path: Path):
    """A jar with just enough in it to drive render_item end to end."""
    with zipfile.ZipFile(path, "w") as jar:
        def item(name, definition):
            jar.writestr(f"assets/minecraft/items/{name}.json", json.dumps(definition))

        def model(ref, body):
            jar.writestr(f"assets/minecraft/models/{ref}.json", json.dumps(body))

        def texture(ref, colour, size=16):
            jar.writestr(f"assets/minecraft/textures/{ref}.png", png(colour, size))

        # --- a flat item
        item("flat_thing", {"model": {"type": "minecraft:model", "model": "minecraft:item/flat_thing"}})
        model("item/flat_thing", {"parent": "item/generated", "textures": {"layer0": "item/flat_thing"}})
        texture("item/flat_thing", RED)

        # --- a full cube, one colour per face so shading is readable per direction
        item("test_cube", {"model": {"type": "minecraft:model", "model": "minecraft:block/test_cube"}})
        model("block/test_cube", {
            "textures": {"up": "block/up", "down": "block/down", "north": "block/north",
                         "south": "block/south", "east": "block/east", "west": "block/west"},
            "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                          "faces": {name: {"texture": f"#{name}"} for name in
                                    ("up", "down", "north", "south", "east", "west")}}],
        })
        for name, colour in (("up", WHITE), ("down", RED), ("north", GREEN),
                             ("south", BLUE), ("east", YELLOW), ("west", (200, 60, 200))):
            texture(f"block/{name}", colour)

        # --- one cube in a single colour: brightness alone distinguishes the faces
        item("plain_cube", {"model": {"type": "minecraft:model", "model": "minecraft:block/plain_cube"}})
        model("block/plain_cube", {"textures": {"all": "block/plain"},
                                   "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                                 "faces": cube_faces()}]})
        texture("block/plain", WHITE)

        # --- two elements, the near one small: a centroid sort can order these wrongly
        item("two_part", {"model": {"type": "minecraft:model", "model": "minecraft:block/two_part"}})
        model("block/two_part", {
            "textures": {"far": "block/north", "near": "block/east"},
            "elements": [
                {"from": [0, 0, 0], "to": [16, 16, 8], "faces": cube_faces("#far")},
                {"from": [6, 6, 8], "to": [10, 10, 16], "faces": cube_faces("#near")},
            ],
        })

        # --- two posts at opposite corners, one colour: shading is the only variable
        item("posts", {"model": {"type": "minecraft:model", "model": "minecraft:block/posts"}})
        model("block/posts", {"textures": {"all": "block/plain"}, "elements": [
            {"from": [0, 0, 0], "to": [4, 16, 4], "faces": cube_faces()},
            {"from": [12, 0, 12], "to": [16, 16, 16], "faces": cube_faces()},
        ]})

        # --- a post skewered through a slab. They interpenetrate, so NO ordering of
        #     whole faces is right: the post is in front of the slab above it and
        #     behind the slab below it, and one painter's-algorithm pass must get
        #     one of those wrong.
        item("skewer", {"model": {"type": "minecraft:model", "model": "minecraft:block/skewer"}})
        model("block/skewer", {"textures": {"slab": "block/north", "post": "block/east"},
                               "elements": [
                                   {"from": [0, 6, 0], "to": [16, 10, 16], "faces": cube_faces("#slab")},
                                   {"from": [6, 0, 6], "to": [10, 16, 10], "faces": cube_faces("#post")},
                               ]})

        # --- two crossed planes, the shape vanilla uses for plants. Their centroids
        #     are identical, so the sort is arbitrary and one plane wins outright.
        #     22.5 deg, not 45: at 45 one plane is exactly edge-on to the 30/225 view
        #     and invisible for honest reasons, which would prove nothing.
        item("crossed", {"model": {"type": "minecraft:model", "model": "minecraft:block/crossed"}})
        model("block/crossed", {"textures": {"a": "block/north", "b": "block/east"}, "elements": [
            {"from": [0.8, 0, 8], "to": [15.2, 16, 8], "shade": False,
             "rotation": {"origin": [8, 8, 8], "axis": "y", "angle": 22.5},
             "faces": {"north": {"texture": "#a"}, "south": {"texture": "#a"}}},
            {"from": [8, 0, 0.8], "to": [8, 16, 15.2], "shade": False,
             "rotation": {"origin": [8, 8, 8], "axis": "y", "angle": 22.5},
             "faces": {"west": {"texture": "#b"}, "east": {"texture": "#b"}}},
        ]})

        # --- a special type nothing supports (banners, beds, signs all land here)
        item("mystery", {"model": {"type": "minecraft:special", "base": "minecraft:item/mystery",
                                   "model": {"type": "minecraft:banner"}}})
        model("item/mystery", {"parent": "item/generated", "textures": {"layer0": "item/mystery"}})
        texture("item/mystery", BLUE)

        # --- and one with no flat texture to fall back to at all
        item("hopeless", {"model": {"type": "minecraft:special", "base": "minecraft:item/hopeless",
                                    "model": {"type": "minecraft:conduit"}}})


tmp = Path(tempfile.mkdtemp())
jar_path = tmp / "synthetic.jar"
build_jar(jar_path)
assets = ba.Assets(jar_path)


def render(item):
    return ba.render_item(assets, item)


def colours(icon):
    """Opaque colours present, most common first."""
    counts = {}
    pixels = icon.convert("RGBA").load()
    width, height = icon.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a > 200:
                counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
    return [c for c, _ in sorted(counts.items(), key=lambda kv: -kv[1])]


def nearest(colour, options):
    return min(options, key=lambda o: sum((a - b) ** 2 for a, b in zip(colour, o)))


# --- a flat item renders its layer at full brightness
flat = render("flat_thing")
assert flat is not None, "a plain item/generated model must render"
assert flat.size == (ba.ICON, ba.ICON), flat.size
assert nearest(colours(flat)[0], [RED, WHITE]) == RED, colours(flat)[:3]

# --- shading follows the face DIRECTION, with vanilla's constants.
#     It used to be picked from the face's screen position, which put north and east
#     the wrong way round: every 3D icon was lit backwards. Measured, not assumed.
family = {"up": WHITE, "down": RED, "north": GREEN, "south": BLUE, "east": YELLOW, "west": (200, 60, 200)}


def lighting(icon, base):
    """Which faces are visible, and how bright each came out.

    A shaded colour is its texture scaled down, so match on the ratio rather than
    on distance — a dimmed yellow is nearer to green than to yellow.
    """
    out = {}
    for colour in colours(icon):
        for name, full in base.items():
            peak = max(full) or 1
            scale = max(colour) / peak
            if scale > 0.05 and all(abs(v - round(f * scale)) <= 24 for v, f in zip(colour, full)):
                out.setdefault(name, round(scale, 2))
                break
    return out


cube = render("test_cube")
assert cube is not None, "a block model must render"
lit = lighting(cube, family)
assert set(lit) == {"up", "north", "east"}, f"the 30/225 view shows the top and two sides, got {lit}"
assert lit["up"] == 1.0, lit
assert lit["north"] == 0.8, f"vanilla lights north at 0.8, got {lit}"
assert lit["east"] == 0.6, f"vanilla lights east at 0.6, got {lit}"
assert ba.SHADE == {"up": 1.0, "down": 0.5, "north": 0.8, "south": 0.8, "west": 0.6, "east": 0.6}, ba.SHADE

# a single-colour cube: three shades, one per visible direction
plain = render("plain_cube")
levels = sorted({round(c[0] / WHITE[0], 2) for c in colours(plain)})
assert levels == [0.6, 0.8, 1.0], f"one shade per visible direction: {levels}"

# and a multi-element model must not light same-direction faces differently
two_levels = sorted({round(c[0] / WHITE[0], 2) for c in colours(render("posts"))})
assert two_levels == [0.6, 0.8, 1.0], \
    f"faces pointing the same way must share a shade whatever element they're on: {two_levels}"

# --- the down UV default flips z, where up does not. A full 0..16 cube can't show
#     the difference (the flip is symmetric), so use an element that isn't centred.
start, end = [0, 0, 2], [16, 16, 10]
assert ba.DEFAULT_UV["up"](start, end) == [0, 2, 16, 10], ba.DEFAULT_UV["up"](start, end)
assert ba.DEFAULT_UV["down"](start, end) == [0, 6, 16, 14], \
    f"vanilla FaceBakery maps DOWN to [x1, 16-z2, x2, 16-z1]; got {ba.DEFAULT_UV['down'](start, end)}"

# --- an unsupported special still produces an icon rather than nothing
mystery = render("mystery")
assert mystery is not None, \
    "an unsupported special type should fall back to its flat texture, not vanish"
assert nearest(colours(mystery)[0], [BLUE, WHITE]) == BLUE, colours(mystery)[:3]

# --- but one with nothing to fall back to is still honestly missing
assert render("hopeless") is None, "with no texture at all there is nothing to draw"

# --- a two-element model draws both parts
two = render("two_part")
assert two is not None
assert len(colours(two)) >= 2, "both elements should contribute pixels"

# --- depth is per pixel, not per face.
#     Sorting faces by centroid and painting back to front cannot express "this face
#     is in front over here and behind over there", so interpenetrating elements come
#     out wrong. Setting DEPTH_EPS to infinity accepts every pixel, which is exactly
#     the old painter-only renderer — so each check below runs both ways and asserts
#     the artefact is there without the depth test and gone with it. That keeps the
#     fixtures honest: if a future change made them stop exercising the bug, the
#     "before" assertion fails rather than the test quietly proving nothing.
MIDDLE = ba.ICON // 2


def colour_at(icon, x, y):
    r, g, b, a = icon.convert("RGBA").load()[x, y]
    if a < 200:
        return None
    return nearest((r, g, b), [GREEN, YELLOW, WHITE])


def with_depth_test(enabled, item):
    ba.DEPTH_EPS, previous = (1e-6 if enabled else float("inf")), ba.DEPTH_EPS
    try:
        return render(item)
    finally:
        ba.DEPTH_EPS = previous


# the slab (green) must hide the length of post (yellow) buried behind it
buried = lambda icon: colour_at(icon, MIDDLE, MIDDLE)
assert buried(with_depth_test(False, "skewer")) == YELLOW, \
    "fixture no longer exercises the bug: centroid sorting already hides the post"
assert buried(with_depth_test(True, "skewer")) == GREEN, \
    "the slab is in front of the post at the icon's centre and must occlude it"

# ...but the post above the slab is genuinely in front, and must survive. Without
# this a depth test with its comparison the wrong way round would still pass above.
standing = lambda icon: colour_at(icon, MIDDLE, 12)
assert standing(with_depth_test(True, "skewer")) == YELLOW, \
    "the post above the slab is nearest the viewer; the depth test must keep it"

# crossed planes: each is in front over part of the overlap, so both must show
row = lambda icon: {colour_at(icon, x, MIDDLE) for x in range(ba.ICON)} - {None}
assert row(with_depth_test(False, "crossed")) == {YELLOW}, \
    "fixture no longer exercises the bug: one plane should win outright without depth"
assert row(with_depth_test(True, "crossed")) == {GREEN, YELLOW}, \
    f"both planes are in front somewhere along the middle row, got {row(with_depth_test(True, 'crossed'))}"

print("ALL ICON TESTS PASSED")
