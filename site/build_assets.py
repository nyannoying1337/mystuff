#!/usr/bin/env python3
"""Builds the page's Minecraft icons from the official client jar.

Nothing from the game is committed to the repo: the Pages workflow runs this at
deploy time, downloading the client jar from Mojang, and publishes the
rendered icons with the site. See the usage-guidelines note in the README.

Output (site/assets/mc/):
  item/<id>.png   48×48 inventory icon for every item, 3D blocks included
  hud/*.png       hearts, hunger, XP bar, hotbar, inventory screen, empty-slot sprites
  font/<n>.png    digit and "/" glyphs from the default font
  glint.png       enchantment glint texture
  names.json      English item and enchantment names for tooltips
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

MC_VERSION = "26.2"
ICON = 48  # output size; the GUI draws items in a 16px box, so this is 3×
HERE = Path(__file__).resolve().parent
OUT = HERE / "assets" / "mc"
CACHE = HERE / ".cache"

HUD_SPRITES = {
    "heart_container": "gui/sprites/hud/heart/container.png",
    "heart_full": "gui/sprites/hud/heart/full.png",
    "heart_half": "gui/sprites/hud/heart/half.png",
    "food_empty": "gui/sprites/hud/food_empty.png",
    "food_full": "gui/sprites/hud/food_full.png",
    "food_half": "gui/sprites/hud/food_half.png",
    "xp_background": "gui/sprites/hud/experience_bar_background.png",
    "xp_progress": "gui/sprites/hud/experience_bar_progress.png",
    "hotbar": "gui/sprites/hud/hotbar.png",
    "hotbar_selection": "gui/sprites/hud/hotbar_selection.png",
    "slot_helmet": "gui/sprites/container/slot/helmet.png",
    "slot_chestplate": "gui/sprites/container/slot/chestplate.png",
    "slot_leggings": "gui/sprites/container/slot/leggings.png",
    "slot_boots": "gui/sprites/container/slot/boots.png",
    "slot_shield": "gui/sprites/container/slot/shield.png",
}
INVENTORY_SCREEN = ("gui/container/inventory.png", (0, 0, 176, 166))
GENERATED = {"item/generated", "builtin/generated"}


# ---------------------------------------------------------------- jar access

def fetch_client_jar(version: str) -> Path:
    CACHE.mkdir(exist_ok=True)
    jar = CACHE / f"client-{version}.jar"
    manifest = json.load(urllib.request.urlopen(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"))
    entry = next(v for v in manifest["versions"] if v["id"] == version)
    download = json.load(urllib.request.urlopen(entry["url"]))["downloads"]["client"]
    if not jar.is_file() or hashlib.sha1(jar.read_bytes()).hexdigest() != download["sha1"]:
        print(f"downloading Minecraft {version} client jar")
        urllib.request.urlretrieve(download["url"], jar)
        if hashlib.sha1(jar.read_bytes()).hexdigest() != download["sha1"]:
            jar.unlink()
            raise SystemExit("client jar checksum mismatch")
    return jar


class Assets:
    def __init__(self, jar: Path):
        self.zip = zipfile.ZipFile(jar)
        self.names = set(self.zip.namelist())
        self.models: dict[str, dict] = {}
        self.textures: dict[str, Image.Image | None] = {}

    def json(self, path: str) -> dict | None:
        full = f"assets/minecraft/{path}"
        return json.loads(self.zip.read(full)) if full in self.names else None

    def image(self, path: str) -> Image.Image | None:
        full = f"assets/minecraft/textures/{path}"
        if full not in self.names:
            return None
        return Image.open(io.BytesIO(self.zip.read(full))).convert("RGBA")

    def texture(self, ref: str) -> Image.Image | None:
        ref = strip(ref)
        if ref not in self.textures:
            image = self.image(f"{ref}.png")
            # Animated textures are frames stacked vertically; keep the first.
            if image and image.height > image.width and image.height % image.width == 0:
                image = image.crop((0, 0, image.width, image.width))
            self.textures[ref] = image
        return self.textures[ref]

    def model(self, ref: str) -> dict | None:
        ref = strip(ref)
        if ref not in self.models:
            self.models[ref] = self.json(f"models/{ref}.json")
        return self.models[ref]


def strip(ref: str) -> str:
    return ref.removeprefix("minecraft:")


# ------------------------------------------------------------ model resolving

def pick_model(node: dict | None) -> tuple[str, list] | tuple[str, list, dict] | None:
    """Walk an item definition down to the model shown in an inventory slot."""
    if not node:
        return None
    kind = strip(node.get("type", ""))
    if kind == "model":
        return node["model"], node.get("tints", [])
    if kind == "special":
        return node["base"], [], node.get("model", {})
    if kind == "select" and strip(node.get("property", "")) == "display_context":
        for case in node.get("cases", []):
            when = case.get("when")
            if when == "gui" or (isinstance(when, list) and "gui" in when):
                return pick_model(case["model"])
    if kind == "composite":
        return pick_model((node.get("models") or [None])[0])
    if kind == "condition":  # e.g. bow not being drawn, elytra not broken
        return pick_model(node.get("on_false"))
    if kind in ("select", "range_dispatch"):
        fallback = node.get("fallback")
        if fallback:
            return pick_model(fallback)
        options = node.get("cases") or node.get("entries") or []
        return pick_model(options[0]["model"]) if options else None
    return None


def flatten(assets: Assets, ref: str) -> dict:
    """Merge a model with its parents: textures, elements, gui display."""
    textures: dict[str, str] = {}
    elements = None
    display = None
    parents = []
    current = ref
    for _ in range(20):
        model = assets.model(current)
        if model is None:
            break
        for key, value in model.get("textures", {}).items():
            textures.setdefault(key, value)
        if elements is None and "elements" in model:
            elements = model["elements"]
        if display is None and "gui" in model.get("display", {}):
            display = model["display"]["gui"]
        parent = model.get("parent")
        if not parent:
            break
        current = strip(parent)
        parents.append(current)
    return {"textures": textures, "elements": elements, "display": display, "parents": parents}


def sprite(value):
    # 26.x allows {"sprite": "...", "force_translucent": true} in place of a plain id
    return value.get("sprite") if isinstance(value, dict) else value


def resolve_texture(textures: dict, key: str) -> str | None:
    value = sprite(textures.get(key.lstrip("#")))
    for _ in range(10):
        if value is None or not value.startswith("#"):
            return value
        value = sprite(textures.get(value[1:]))
    return None


def tint_color(assets: Assets, tint: dict) -> tuple[int, int, int] | None:
    kind = strip(tint.get("type", ""))
    if kind == "constant":
        value = tint["value"]
    elif kind in ("grass", "foliage", "dry_foliage"):
        colormap = assets.image(f"colormap/{kind}.png")
        if colormap is None:
            return None
        temperature = min(max(tint.get("temperature", 0.5), 0.0), 1.0)
        downfall = min(max(tint.get("downfall", 1.0), 0.0), 1.0) * temperature
        x = int((1 - temperature) * 255)
        y = int((1 - downfall) * 255)
        return colormap.getpixel((x, y))[:3]
    elif "default" in tint:
        value = tint["default"]
    else:
        return None
    value &= 0xFFFFFF
    return (value >> 16) & 255, (value >> 8) & 255, value & 255


def multiply(image: Image.Image, color: tuple[int, int, int], shade: float = 1.0) -> Image.Image:
    r, g, b, a = image.split()
    factors = [c / 255 * shade for c in color]
    return Image.merge("RGBA", (
        r.point(lambda v: int(v * factors[0])),
        g.point(lambda v: int(v * factors[1])),
        b.point(lambda v: int(v * factors[2])),
        a,
    ))


# ------------------------------------------------------------------ rendering

def render_flat(assets: Assets, model: dict, tints: list) -> Image.Image | None:
    icon = Image.new("RGBA", (16, 16))
    drawn = False
    for index in range(8):
        ref = resolve_texture(model["textures"], f"layer{index}")
        if ref is None:
            break
        texture = assets.texture(ref)
        if texture is None:
            continue
        if index < len(tints):
            color = tint_color(assets, tints[index])
            if color:
                texture = multiply(texture, color)
        icon.alpha_composite(texture.resize((16, 16), Image.NEAREST))
        drawn = True
    return icon.resize((ICON, ICON), Image.NEAREST) if drawn else None


def rotate(vector, rx, ry, rz):
    """JOML rotationXYZ, as Minecraft's ItemTransform applies it."""
    x, y, z = vector
    cz, sz = math.cos(rz), math.sin(rz)
    x, y = x * cz - y * sz, x * sz + y * cz
    cy, sy = math.cos(ry), math.sin(ry)
    x, z = x * cy + z * sy, -x * sy + z * cy
    cx, sx = math.cos(rx), math.sin(rx)
    y, z = y * cx - z * sx, y * sx + z * cx
    return x, y, z


FACE_CORNERS = {  # top-left, top-right, bottom-right, bottom-left, as UVs lay out
    "up": lambda f, t: [(f[0], t[1], f[2]), (t[0], t[1], f[2]), (t[0], t[1], t[2]), (f[0], t[1], t[2])],
    "down": lambda f, t: [(f[0], f[1], t[2]), (t[0], f[1], t[2]), (t[0], f[1], f[2]), (f[0], f[1], f[2])],
    "north": lambda f, t: [(t[0], t[1], f[2]), (f[0], t[1], f[2]), (f[0], f[1], f[2]), (t[0], f[1], f[2])],
    "south": lambda f, t: [(f[0], t[1], t[2]), (t[0], t[1], t[2]), (t[0], f[1], t[2]), (f[0], f[1], t[2])],
    "west": lambda f, t: [(f[0], t[1], f[2]), (f[0], t[1], t[2]), (f[0], f[1], t[2]), (f[0], f[1], f[2])],
    "east": lambda f, t: [(t[0], t[1], t[2]), (t[0], t[1], f[2]), (t[0], f[1], f[2]), (t[0], f[1], t[2])],
}
DEFAULT_UV = {
    "up": lambda f, t: [f[0], f[2], t[0], t[2]],
    "down": lambda f, t: [f[0], f[2], t[0], t[2]],
    "north": lambda f, t: [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]],
    "south": lambda f, t: [f[0], 16 - t[1], t[0], 16 - f[1]],
    "west": lambda f, t: [f[2], 16 - t[1], t[2], 16 - f[1]],
    "east": lambda f, t: [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]],
}


def element_rotation(point, rotation):
    if not rotation:
        return point
    origin = rotation.get("origin", [8, 8, 8])
    angle = math.radians(rotation.get("angle", 0))
    axis = rotation.get("axis", "y")
    x, y, z = (point[i] - origin[i] for i in range(3))
    c, s = math.cos(angle), math.sin(angle)
    if axis == "x":
        y, z = y * c - z * s, y * s + z * c
    elif axis == "y":
        x, z = x * c + z * s, -x * s + z * c
    else:
        x, y = x * c - y * s, x * s + y * c
    return x + origin[0], y + origin[1], z + origin[2]


def render_block(assets: Assets, model: dict, tints: list) -> Image.Image | None:
    display = model["display"] or {"rotation": [30, 225, 0], "scale": [0.625] * 3}
    rx, ry, rz = (math.radians(a) for a in display.get("rotation", [0, 0, 0]))
    sx, sy, sz = display.get("scale", [1, 1, 1])
    tx, ty, tz = display.get("translation", [0, 0, 0])
    px = ICON / 16

    def project(point):
        # model units (0..16) -> centred block units -> display transform -> icon pixels
        x, y, z = ((point[i] - 8) / 16 for i in range(3))
        x, y, z = rotate((x * sx, y * sy, z * sz), rx, ry, rz)
        return (8 + x * 16 + tx) * px, (8 - y * 16 - ty) * px, z

    faces = []
    for element in model["elements"]:
        start, end = element["from"], element["to"]
        for name, face in element.get("faces", {}).items():
            corners = [element_rotation(c, element.get("rotation")) for c in FACE_CORNERS[name](start, end)]
            screen = [project(c) for c in corners]
            # back-face cull using the projected winding
            (x0, y0, _), (x1, y1, _), (x3, y3, _) = screen[0], screen[1], screen[3]
            if (x1 - x0) * (y3 - y0) - (y1 - y0) * (x3 - x0) <= 0:
                continue
            depth = sum(p[2] for p in screen) / 4
            uv_box = face.get("uv") or DEFAULT_UV[name](start, end)
            faces.append((depth, name, face, screen, element.get("shade", True), uv_box))

    icon = Image.new("RGBA", (ICON, ICON))
    drawn = False
    for depth, name, face, screen, shade, uv_box in sorted(faces, key=lambda f: f[0]):
        ref = resolve_texture(model["textures"], face.get("texture", ""))
        texture = assets.texture(ref) if ref else None
        if texture is None:
            continue
        scale = texture.width / 16
        u1, v1, u2, v2 = uv_box
        uv = [(u1, v1), (u2, v1), (u2, v2), (u1, v2)]
        turns = int(face.get("rotation", 0)) // 90 % 4
        uv = uv[turns:] + uv[:turns]

        brightness = 1.0
        if shade:
            normal_y = {"up": 1, "down": -1}.get(name, 0)
            if normal_y > 0:
                brightness = 1.0
            elif normal_y < 0:
                brightness = 0.5
            else:
                # left-facing sides get more light than right-facing ones, like the GUI lighting
                mid_x = sum(p[0] for p in screen) / 4
                brightness = 0.8 if mid_x < ICON / 2 else 0.6
        color = (255, 255, 255)
        if "tintindex" in face and face["tintindex"] < len(tints):
            color = tint_color(assets, tints[face["tintindex"]]) or color
        texture = multiply(texture, color, brightness)

        (X0, Y0, _), (X1, Y1, _), _, (X3, Y3, _) = screen
        (U0, V0), (U1, V1), _, (U3, V3) = [(u * scale, v * scale) for u, v in uv]
        det = (X1 - X0) * (Y3 - Y0) - (X3 - X0) * (Y1 - Y0)
        if abs(det) < 1e-6:
            continue
        # inverse affine: icon pixel -> (a, b) in face space -> texture pixel
        ia = ((Y3 - Y0) / det, -(X3 - X0) / det)
        ib = (-(Y1 - Y0) / det, (X1 - X0) / det)

        def coefficients(t0, t1, t3):
            ca = (t1 - t0) * ia[0] + (t3 - t0) * ib[0]
            cb = (t1 - t0) * ia[1] + (t3 - t0) * ib[1]
            return ca, cb, t0 - ca * X0 - cb * Y0

        cu = coefficients(U0, U1, U3)
        cv = coefficients(V0, V1, V3)
        warped = texture.transform((ICON, ICON), Image.AFFINE, (*cu, *cv), resample=Image.NEAREST)

        # clip to the face's parallelogram (the texture may be larger than the UV window)
        mask = Image.new("L", (ICON, ICON))
        ImageDraw.Draw(mask).polygon([(p[0], p[1]) for p in screen], fill=255)
        alpha = Image.composite(warped.getchannel("A"), Image.new("L", (ICON, ICON)), mask)
        warped.putalpha(alpha)
        icon.alpha_composite(warped)
        drawn = True
    return icon if drawn else None


HEAD_TEXTURES = {
    "skeleton": "entity/skeleton/skeleton",
    "wither_skeleton": "entity/skeleton/wither_skeleton",
    "zombie": "entity/zombie/zombie",
    "creeper": "entity/creeper/creeper",
    "piglin": "entity/piglin/piglin",
    "player": "entity/player/wide/steve",
}


def entity_box(start, end, tex_origin, size, texture_px_per_unit, remap=None, flip_sides=False,
               faces=("up", "north", "south", "east", "west")):
    """A model element textured with the standard entity-model UV unwrap.

    `remap` maps a visible face to the texture region drawn on it, and
    `flip_sides` turns side regions upside down — block-entity textures are
    authored for models that are built upside down.
    """
    u, v = tex_origin
    w, h, d = size
    regions = {
        "up": (u + d, v, u + d + w, v + d),
        "down": (u + d + w, v, u + d + 2 * w, v + d),
        "north": (u + d, v + d, u + d + w, v + d + h),
        "south": (u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h),
        "west": (u, v + d, u + d, v + d + h),
        "east": (u + d + w, v + d, u + 2 * d + w, v + d + h),
    }
    remap = remap or {}
    built = {}
    for name in faces:
        u1, v1, u2, v2 = regions[remap.get(name, name)]
        if flip_sides and name not in ("up", "down"):
            v1, v2 = v2, v1
        built[name] = {"texture": "#entity", "uv": [c / texture_px_per_unit for c in (u1, v1, u2, v2)]}
    return {"from": start, "to": end, "faces": built}


def special_model(assets: Assets, base: dict, special: dict) -> dict | None:
    """Rebuild the few block-entity items that are simple boxes."""
    kind = strip(special.get("type", ""))
    if kind == "chest":
        texture = f"entity/chest/{strip(special.get('texture', 'normal'))}"
        chest = {"up": "down"}
        boxes = lambda s: [
            entity_box([1, 0, 1], [15, 10, 15], (0, 19), (14, 10, 14), s, chest, True),
            entity_box([1, 9, 1], [15, 14, 15], (0, 0), (14, 5, 14), s, chest, True),
            entity_box([7, 7, 0], [9, 11, 1], (0, 0), (2, 4, 1), s, chest, True),
        ]
    elif kind == "shulker_box":
        texture = f"entity/shulker/{strip(special.get('texture', 'shulker'))}"
        boxes = lambda s: [
            entity_box([0, 0, 0], [16, 8, 16], (0, 28), (16, 8, 16), s),
            entity_box([0, 4, 0], [16, 16, 16], (0, 0), (16, 12, 16), s),
        ]
    elif kind in ("head", "player_head"):
        texture = HEAD_TEXTURES.get(special.get("kind", "player"))
        if texture is None:
            return None
        # the item turns the skull around, so its face ends up on the viewer's side
        turned = {"north": "south", "south": "north", "east": "west", "west": "east"}
        boxes = lambda s: [entity_box([4, 0, 4], [12, 8, 12], (0, 0), (8, 8, 8), s, turned)]
    else:
        return None

    image = assets.texture(texture)
    if image is None:
        return None
    return {
        "textures": {"entity": texture},
        "elements": boxes(image.width / 16),
        "display": base["display"],
        "parents": [],
    }


def render_item(assets: Assets, item: str) -> Image.Image | None:
    definition = assets.json(f"items/{item}.json")
    picked = pick_model(definition.get("model") if definition else None)
    if not picked:
        return None
    ref, tints = picked[0], picked[1]
    model = flatten(assets, ref)
    if len(picked) == 3:
        rebuilt = special_model(assets, model, picked[2])
        if rebuilt:
            return render_block(assets, rebuilt, [])
        return None  # banners, shields, pots…: the page shows its fallback swatch
    if any(parent in GENERATED for parent in model["parents"]) or strip(ref) in GENERATED:
        return render_flat(assets, model, tints)
    if model["elements"]:
        return render_block(assets, model, tints)
    # special renderers (chests, beds, heads…) have no geometry here: use their particle texture
    particle = resolve_texture(model["textures"], "particle")
    if particle and assets.texture(particle):
        return assets.texture(particle).resize((ICON, ICON), Image.NEAREST)
    return None


# ----------------------------------------------------------------------- main

def build_names(assets: Assets) -> None:
    """English item and enchantment names for the inventory tooltips."""
    lang = assets.json("lang/en_us.json") or {}
    blocks, items, enchantments, levels = {}, {}, {}, {}
    for key, value in lang.items():
        kind, _, rest = key.partition(".")
        namespace, _, name = rest.partition(".")
        if not name or "." in name:
            continue
        if kind == "block" and namespace == "minecraft":
            blocks[name] = value
        elif kind == "item" and namespace == "minecraft":
            items[name] = value
        elif kind == "enchantment" and namespace == "minecraft":
            enchantments[name] = value
        elif kind == "enchantment" and namespace == "level":
            levels[name] = value
    items = {**blocks, **items}  # an item's own name wins over its block's
    (OUT / "names.json").write_text(
        json.dumps({"items": items, "enchantments": enchantments, "levels": levels}, separators=(",", ":")),
        encoding="utf-8",
    )


def build_font(assets: Assets) -> None:
    sheet = assets.image("font/ascii.png")
    cell = sheet.width // 16
    (OUT / "font").mkdir(parents=True, exist_ok=True)
    widths = {}
    for char in "0123456789/":
        code = ord(char)
        glyph = sheet.crop(((code % 16) * cell, (code // 16) * cell, (code % 16 + 1) * cell, (code // 16 + 1) * cell))
        columns = [x for x in range(cell) if any(glyph.getpixel((x, y))[3] for y in range(cell))]
        width = (max(columns) + 1) if columns else cell // 2
        glyph.crop((0, 0, width, cell)).save(OUT / "font" / f"{code}.png")
        widths[char] = width
    (OUT / "font" / "widths.json").write_text(json.dumps(widths), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--jar", type=Path, help="use this client jar instead of downloading one")
    parser.add_argument("--version", default=MC_VERSION)
    parser.add_argument("--only", help="comma-separated item ids, for quick checks")
    args = parser.parse_args()

    assets = Assets(args.jar or fetch_client_jar(args.version))

    (OUT / "hud").mkdir(parents=True, exist_ok=True)
    for name, path in HUD_SPRITES.items():
        assets.image(path).save(OUT / "hud" / f"{name}.png")
    screen_path, screen_box = INVENTORY_SCREEN
    assets.image(screen_path).crop(screen_box).save(OUT / "hud" / "inventory.png")
    assets.image("misc/enchanted_glint_item.png").save(OUT / "glint.png")
    build_font(assets)
    build_names(assets)

    items = sorted(
        Path(name).stem for name in assets.names
        if name.startswith("assets/minecraft/items/") and name.endswith(".json")
    )
    if args.only:
        items = [item for item in items if item in args.only.split(",")]

    if not args.only:
        shutil.rmtree(OUT / "item", ignore_errors=True)  # no stale icons from an older version
    (OUT / "item").mkdir(parents=True, exist_ok=True)
    missing = []
    for item in items:
        try:
            icon = render_item(assets, item)
        except Exception as err:  # one odd model shouldn't sink the deploy
            print(f"  {item}: {err}", file=sys.stderr)
            icon = None
        if icon is None:
            missing.append(item)
            continue
        icon.save(OUT / "item" / f"{item}.png", optimize=True)

    print(f"{len(items) - len(missing)} item icons, {len(missing)} without one")
    if missing:
        print("  no icon:", ", ".join(missing[:20]) + (" …" if len(missing) > 20 else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
