#!/usr/bin/env python3
"""Regenerates max_durability.json from a Minecraft server jar.

Player NBT only stores an item's damage, not its maximum, unless the maximum
was changed. The vanilla defaults come from the game's own data reports:

    python update_durability.py --server-jar server.jar
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent / "max_durability.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server-jar", type=Path, required=True)
    parser.add_argument("--java", default="java")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as work:
        subprocess.run(
            [args.java, "-DbundlerMainClass=net.minecraft.data.Main", "-jar", str(args.server_jar.resolve()),
             "--reports", "--output", str(Path(work) / "out")],
            cwd=work, check=True, capture_output=True,
        )
        table = {}
        for path in sorted((Path(work) / "out" / "reports" / "minecraft" / "components" / "item").glob("*.json")):
            components = json.loads(path.read_text(encoding="utf-8")).get("components", {})
            if components.get("minecraft:max_damage"):
                table[f"minecraft:{path.stem}"] = components["minecraft:max_damage"]

    OUT.write_text(json.dumps(table, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {len(table)} items to {OUT.name}")


if __name__ == "__main__":
    main()
