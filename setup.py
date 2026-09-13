#!/usr/bin/env python3
"""mc-status setup: everything between "I forked the repo" and "it's live".

    python setup.py                 guided setup; safe to run again
    python setup.py invite          new invite key and link (old links stop working)
    python setup.py token           new push token for the agent
    python setup.py deploy          deploy the Worker from this machine
    python setup.py worker-config   write worker/wrangler.generated.toml (used by CI)
    python setup.py autostart       start the agent when you log in
    python setup.py server          optional server tool: keys, and the server mod's config file

Secrets are generated here and handed straight to wrangler (and to GitHub if
the gh CLI is installed). They're never printed; the push token is also kept in
agent/config.toml, which is gitignored.

Needs Python 3.11+. Deploying from this machine also needs Node.js (for npx).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
AGENT = ROOT / "agent"
WORKER = ROOT / "worker"
CONFIG = AGENT / "config.toml"
EXAMPLE = AGENT / "config.example.toml"
WRANGLER = ["npx", "--yes", "wrangler@4"]
TASK_NAME = "mc-status agent"

DRY_RUN = False
ASSUME_YES = False

# never crash on a console that can't show a character
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")


# ---------------------------------------------------------------- terminal helpers

def say(text: str = "") -> None:
    print(text, flush=True)


def step(title: str) -> None:
    say(f"\n== {title}")


def ask(question: str, default: str = "") -> str:
    if ASSUME_YES:
        return default
    suffix = f" [{default}]" if default else ""
    answer = input(f"{question}{suffix}: ").strip()
    return answer or default


def confirm(question: str, default: bool = True) -> bool:
    if ASSUME_YES:
        return default
    answer = input(f"{question} [{'Y/n' if default else 'y/N'}]: ").strip().lower()
    return default if not answer else answer.startswith("y")


def run(command: list[str], *, cwd: Path | None = None, input_text: str | None = None, capture: bool = False):
    if DRY_RUN:
        say(f"  (dry run) would run: {' '.join(command)}")
        return subprocess.CompletedProcess(command, 0, "", "")
    executable = shutil.which(command[0])
    if not executable:
        raise FileNotFoundError(command[0])
    # wrangler prints UTF-8 (emoji, box drawing); the console's code page can't decode that
    return subprocess.run([executable, *command[1:]], cwd=cwd, input=input_text, text=True,
                          encoding="utf-8", errors="replace", capture_output=capture)


def copy_to_clipboard(text: str) -> bool:
    for command in (["clip"], ["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"]):
        if shutil.which(command[0]):
            try:
                subprocess.run(command, input=text, text=True, check=True)
                return True
            except (OSError, subprocess.CalledProcessError):
                continue
    return False


# ---------------------------------------------------------------- config.toml

def load_config() -> dict:
    if not CONFIG.is_file():
        return {}
    with CONFIG.open("rb") as handle:
        return tomllib.load(handle)


def set_config_value(section: str, key: str, value: str) -> None:
    """Change one `key = "value"` line inside [section], keeping every comment."""
    if DRY_RUN and CONFIG.is_file():
        say(f"  (dry run) would set [{section}] {key} in {CONFIG.relative_to(ROOT)}")
        return
    if not CONFIG.is_file():
        shutil.copyfile(EXAMPLE, CONFIG)
    text = CONFIG.read_text(encoding="utf-8")
    pattern = re.compile(rf'(^\[{re.escape(section)}\][^\[]*?^{re.escape(key)}\s*=\s*)"[^"]*"', re.M | re.S)
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    if pattern.search(text):
        text = pattern.sub(lambda match: f'{match.group(1)}"{escaped}"', text, count=1)
    elif re.search(rf"^\[{re.escape(section)}\]", text, re.M):
        text = re.sub(rf"(^\[{re.escape(section)}\]\n)", lambda m: f'{m.group(1)}{key} = "{escaped}"\n', text, count=1, flags=re.M)
    else:
        text = f'[{section}]\n{key} = "{escaped}"\n\n' + text
    CONFIG.write_text(text, encoding="utf-8")


def placeholder(value: str | None) -> bool:
    return not value or "change-me" in value or "your-" in value or "example" in value


# ---------------------------------------------------------------- GitHub

def repo_slug() -> str | None:
    try:
        url = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    except OSError:
        return None
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", url)
    return match.group(1) if match else None


def gh_ready() -> bool:
    if DRY_RUN or not shutil.which("gh"):
        return False
    return subprocess.run([shutil.which("gh"), "auth", "status"], capture_output=True).returncode == 0


def github_secret(name: str, value: str) -> bool:
    if not gh_ready():
        return False
    return run(["gh", "secret", "set", name], cwd=ROOT, input_text=value, capture=True).returncode == 0


def github_variable(name: str, value: str) -> bool:
    if not gh_ready():
        return False
    return run(["gh", "variable", "set", name, "--body", value], cwd=ROOT, capture=True).returncode == 0


# ---------------------------------------------------------------- the Worker

def worker_domain(api_url: str) -> str | None:
    """A custom domain gets a route; *.workers.dev needs none."""
    host = urlparse(api_url).hostname or ""
    return None if not host or host.endswith(".workers.dev") or placeholder(api_url) else host


def write_worker_config(api_url: str) -> Path:
    base = (WORKER / "wrangler.toml").read_text(encoding="utf-8")
    domain = worker_domain(api_url)
    if domain:
        route = f'routes = [{{ pattern = "{domain}", custom_domain = true }}]\n'
        base = re.sub(r"^(compatibility_date = .*\n)", lambda m: m.group(1) + route, base, count=1, flags=re.M)
    target = WORKER / "wrangler.generated.toml"
    target.write_text("# Generated by setup.py from wrangler.toml; don't edit.\n" + base, encoding="utf-8")
    return target


def deploy_worker(api_url: str) -> str | None:
    """Deploy with wrangler (it opens a browser to log in the first time).
    Returns the workers.dev URL wrangler reports, if any."""
    generated = write_worker_config(api_url)
    say(f"Deploying the Worker{' to ' + worker_domain(api_url) if worker_domain(api_url) else ''}...")
    result = run([*WRANGLER, "deploy", "-c", generated.name], cwd=WORKER, capture=True)
    output = (result.stdout or "") + (result.stderr or "")
    say(output.strip()[-1500:])
    if result.returncode:
        raise SystemExit("wrangler deploy failed; see the output above")
    match = re.search(r"https://[\w.-]+\.workers\.dev", output)
    return match.group(0) if match else None


def worker_secret(name: str, value: str) -> None:
    """Store a Worker secret without it touching the command line or the screen."""
    say(f"Storing {name} as a Worker secret...")
    generated = write_worker_config(load_config().get("worker", {}).get("url", ""))
    result = run([*WRANGLER, "secret", "put", name, "-c", generated.name], cwd=WORKER, input_text=value, capture=True)
    if result.returncode == 0:
        return
    # Some terminals make wrangler treat piped input as "non-interactive" and
    # ignore the browser login. Then it asks, and you paste from the clipboard.
    if not copy_to_clipboard(value):
        raise SystemExit(f"wrangler couldn't read {name} from stdin and there's no clipboard tool to fall back on")
    say(f"\n{name} is on your clipboard. When wrangler asks for the secret value: paste (Ctrl+V / Cmd+V), then Enter.")
    try:
        if run([*WRANGLER, "secret", "put", name, "-c", generated.name], cwd=WORKER).returncode:
            raise SystemExit(f"wrangler secret put {name} failed")
    finally:
        copy_to_clipboard(" ")
        say("Clipboard cleared.")


def check_worker(api_url: str, token: str) -> bool:
    """A harmless keyed read: 401 means the Worker isn't set up with these secrets yet."""
    if DRY_RUN:
        return True
    request = urllib.request.Request(f"{api_url.rstrip('/')}/status", method="POST", data=b"not json",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as err:
        return err.code == 400  # token accepted, body refused: nothing was changed
    except OSError:
        return False
    return True


# ---------------------------------------------------------------- the mod and the agent

def install_agent_requirements() -> None:
    venv = AGENT / ".venv"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        say("Creating agent/.venv...")
        run([sys.executable, "-m", "venv", str(venv)])
    run([str(python), "-m", "pip", "install", "--quiet", "--upgrade", "-r", str(AGENT / "requirements.txt")])


def agent_python(windowless: bool = False) -> Path:
    venv = AGENT / ".venv"
    if os.name == "nt":
        return venv / "Scripts" / ("pythonw.exe" if windowless else "python.exe")
    return venv / "bin" / "python"


def install_autostart() -> None:
    if sys.platform == "win32":
        run(["powershell", "-ExecutionPolicy", "Bypass", "-File", str(AGENT / "install-windows.ps1")])
        return
    agent = AGENT / "agent.py"
    log = AGENT / "agent.log"
    if sys.platform == "darwin":
        plist = Path.home() / "Library/LaunchAgents/io.github.mc-status.agent.plist"
        body = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.github.mc-status.agent</string>
  <key>ProgramArguments</key><array>
    <string>{agent_python()}</string><string>{agent}</string><string>--config</string><string>{CONFIG}</string>
    <string>--log-file</string><string>{log}</string>
  </array>
  <key>WorkingDirectory</key><string>{AGENT}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
"""
        if DRY_RUN:
            say(f"  (dry run) would write {plist}")
            return
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_text(body, encoding="utf-8")
        run(["launchctl", "unload", str(plist)], capture=True)
        run(["launchctl", "load", str(plist)])
        say(f"Installed {plist}")
        return
    unit = Path.home() / ".config/systemd/user/mc-status-agent.service"
    body = f"""[Unit]
Description=mc-status agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory={AGENT}
ExecStart={agent_python()} {agent} --config {CONFIG} --log-file {log}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
"""
    if DRY_RUN:
        say(f"  (dry run) would write {unit}")
        return
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text(body, encoding="utf-8")
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", "--now", "mc-status-agent.service"])
    say(f"Installed {unit}")


def default_mods_dir() -> Path:
    sys.path.insert(0, str(AGENT))
    from common import default_game_dir, expand  # the agent's own idea of where the game is
    raw = load_config().get("source", {}).get("game_dir", default_game_dir())
    return expand(raw) / "mods"


def download_mod(slug: str) -> None:
    """The newest mc-status jar from this repo's GitHub Releases."""
    with urllib.request.urlopen(f"https://api.github.com/repos/{slug}/releases/latest", timeout=20) as response:
        release = json.load(response)
    jars = [asset for asset in release.get("assets", []) if asset["name"].endswith(".jar")]
    if not jars:
        say(f"The latest release ({release.get('tag_name')}) has no jar attached yet.")
        return
    jar = jars[0]
    mods = default_mods_dir()
    if not confirm(f"Download {jar['name']} ({jar['size'] // 1024} kB) from github.com/{slug} into {mods}?"):
        return
    if DRY_RUN:
        say("  (dry run) skipped the download")
        return
    mods.mkdir(parents=True, exist_ok=True)
    for old in mods.glob("mc-status-*.jar"):
        say(f"Replacing {old.name} (close Minecraft first if it's running)")
        old.unlink()
    urllib.request.urlretrieve(jar["browser_download_url"], mods / jar["name"])
    say(f"Saved {mods / jar['name']}. Fabric Loader and Fabric API need to be installed too.")


# ---------------------------------------------------------------- commands

def new_token(api_url: str, push_to_github: bool = True) -> None:
    token = secrets.token_hex(32)
    worker_secret("PUSH_TOKEN", token)
    set_config_value("worker", "token", token)
    if push_to_github and github_secret("PUSH_TOKEN", token):
        say("Also stored PUSH_TOKEN as a GitHub secret, for the Deploy Worker workflow.")
    say("Wrote the token into agent/config.toml.")
    say("The Worker accepted it." if check_worker(api_url, token) else
        "The Worker didn't accept it yet; secrets can take a minute. Check with: python agent/agent.py --once")


def new_invite(site_url: str, push_to_github: bool = True) -> None:
    key = secrets.token_urlsafe(18)
    worker_secret("VIEW_KEY", key)
    if push_to_github and github_secret("VIEW_KEY", key):
        say("Also stored VIEW_KEY as a GitHub secret, for the Deploy Worker workflow.")
    link = f"{site_url.rstrip('/')}/#key={key}"
    say("\nInvite link. Share it only with people who may watch; running `setup.py invite` again replaces it:")
    say(f"  {link}")


def new_server(api_url: str, site_url: str, server_name: str | None = None) -> None:
    """The optional server tool: its four Worker secrets, and the mod's config file for the server."""
    if not api_url:
        raise SystemExit("No Worker URL: run the guided setup first, or pass --worker-url")
    say("This creates new server tool keys. Running it again replaces them: the server needs the new")
    say("config file, and every admin and player link stops working.")
    if not confirm("Continue?"):
        return
    name = server_name or ask("Server name shown on the admin page", "Minecraft server")
    push_token = secrets.token_hex(32)
    for secret, value in (("SERVER_PUSH_TOKEN", push_token),
                          ("ADMIN_KEY", secrets.token_urlsafe(24)),
                          ("CONTROL_KEY", secrets.token_urlsafe(32)),
                          ("PLAYER_LINK_SECRET", secrets.token_urlsafe(32))):
        worker_secret(secret, value)
        if github_secret(secret, value):
            say(f"Also stored {secret} as a GitHub secret, for the Deploy Worker workflow.")
    page = f"{site_url.rstrip('/')}/server.html" if site_url else ""
    target = ROOT / "server" / "mc-status-server.properties"
    if DRY_RUN:
        say(f"  (dry run) would write {target.relative_to(ROOT)} for {page or 'the server page'}")
        return
    target.parent.mkdir(exist_ok=True)
    target.write_text(
        "# mc-status server tool. Copy into the server's config/ folder. Contains a secret: don't share it.\n"
        f"worker_url={api_url}\n"
        f"push_token={push_token}\n"
        f"site_url={page}\n"
        f"server_name={name}\n"
        "interval_seconds=30\n"
        "share_item_names=false\n",
        encoding="utf-8")
    say(f"\nWrote {target.relative_to(ROOT)} (gitignored).")
    say("On the server (Fabric Loader + Fabric API, Minecraft matching the mod):")
    say("  1. put the mc-status jar in mods/")
    say(f"  2. copy {target.name} into config/")
    say("  3. start it, then in game as an op: /mcstatus admin (view) or /mcstatus control (actions, op level 4)")
    if not page:
        say("No site URL in agent/config.toml: fill in site_url yourself (<your site>/server.html).")


def guided(args) -> None:
    say(__doc__.split("\n\n")[0])
    if sys.version_info < (3, 11):
        raise SystemExit("Python 3.11 or newer is needed")
    config = load_config()
    slug = repo_slug()

    step("1/7  Your site")
    owner, _, repo = (slug or "your-name/mc-status").partition("/")
    default_site = config.get("site", {}).get("url")
    if placeholder(default_site):
        default_site = f"https://{owner.lower()}.github.io/{repo}/"
    site_url = args.site_url or ask("Status page URL (GitHub Pages address, or your own domain)", default_site)
    site_name = args.site_name or ask("Name shown on the page", owner)
    set_config_value("site", "url", site_url)

    step("2/7  The Worker")
    api_url = config.get("worker", {}).get("url", "")
    say("It runs on Cloudflare's free plan: either at mc-status.<your-account>.workers.dev, or at a")
    say("subdomain of a domain whose DNS is on Cloudflare (e.g. status-api.example.com).")
    answer = args.worker_url or ask("Worker URL (leave empty for workers.dev)", "" if placeholder(api_url) else api_url)
    api_url = answer.rstrip("/")
    if api_url and not api_url.startswith("http"):
        api_url = f"https://{api_url}"
    if (shutil.which("npx") or DRY_RUN) and confirm("Deploy the Worker from this machine now? (opens a browser to log in to Cloudflare)"):
        reported = deploy_worker(api_url)
        if not api_url and reported:
            api_url = reported
    elif not api_url:
        say("Deploy it once (python setup.py deploy, or the Deploy Worker workflow) and run setup again with its URL.")
    if api_url:
        set_config_value("worker", "url", api_url)

    step("3/7  Secrets")
    config = load_config()
    token = config.get("worker", {}).get("token")
    if api_url and (placeholder(token) or args.rotate or not check_worker(api_url, token)):
        new_token(api_url)
    elif api_url:
        say("The push token in agent/config.toml already works; keeping it (use --rotate to replace it).")
    invite_needed = api_url and (args.rotate or confirm("Create an invite key and link now?"))

    step("4/7  GitHub")
    if slug:
        say(f"Repository: github.com/{slug}")
    pages = f"https://github.com/{slug}/settings" if slug else "your repository's settings"
    variables = {"MCS_API_URL": api_url, "MCS_SITE_NAME": site_name}
    if all(github_variable(name, value) for name, value in variables.items() if value):
        say("Set the MCS_API_URL and MCS_SITE_NAME repository variables.")
    else:
        say("Set these under Settings -> Secrets and variables -> Actions -> Variables:")
        for name, value in variables.items():
            say(f"  {name} = {value or '(the Worker URL, once deployed)'}")
    say(f"Then, in {pages}:")
    say("  Pages -> Source: GitHub Actions")
    say("  Environments -> github-pages -> Deployment branches: add `map` (for logout maps)")
    say("Optional, to deploy the Worker from GitHub: add the secrets CLOUDFLARE_API_TOKEN")
    say("(template \"Edit Cloudflare Workers\") and CLOUDFLARE_ACCOUNT_ID.")

    step("5/7  The agent")
    if confirm("Install the agent's Python packages into agent/.venv?"):
        install_agent_requirements()
    if confirm("Start the agent automatically when you log in?"):
        install_autostart()

    step("6/7  The mod")
    say("Needs Minecraft with Fabric Loader and Fabric API. The mc-status jar comes from this")
    say("repository's Releases (the Release workflow builds it when you push a tag like v1.0.4).")
    if slug and not DRY_RUN and confirm("Look for the latest release now?"):
        try:
            download_mod(slug)
        except OSError as err:
            say(f"Couldn't fetch the release: {err}")

    step("7/7  Invite")
    if invite_needed:
        new_invite(site_url)
    else:
        say("Create one any time with: python setup.py invite")
    say("\nDone. Push to main to deploy the page.")


def main() -> int:
    global DRY_RUN, ASSUME_YES
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="guided",
                        choices=["guided", "invite", "token", "deploy", "worker-config", "autostart", "server"])
    parser.add_argument("--site-url")
    parser.add_argument("--site-name")
    parser.add_argument("--server-name", help="for `server`: the name shown on the admin page")
    parser.add_argument("--worker-url")
    parser.add_argument("--rotate", action="store_true", help="replace the push token and invite key")
    parser.add_argument("--yes", action="store_true", help="accept every default (for scripts)")
    parser.add_argument("--dry-run", action="store_true", help="write local files only; run nothing, contact nothing")
    args = parser.parse_args()
    DRY_RUN, ASSUME_YES = args.dry_run, args.yes

    api_url = (args.worker_url or os.environ.get("MCS_API_URL") or load_config().get("worker", {}).get("url", "")).rstrip("/")
    if args.command == "guided":
        guided(args)
    elif args.command == "worker-config":
        say(f"wrote {write_worker_config(api_url).relative_to(ROOT)}"
            + (f" with the route {worker_domain(api_url)}" if worker_domain(api_url) else " (workers.dev, no route)"))
    elif args.command == "deploy":
        deploy_worker(api_url)
    elif args.command == "token":
        new_token(api_url)
    elif args.command == "invite":
        new_invite(args.site_url or load_config().get("site", {}).get("url", ""))
    elif args.command == "autostart":
        install_autostart()
    elif args.command == "server":
        new_server(api_url, args.site_url or load_config().get("site", {}).get("url", ""), args.server_name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
