"""Build a deployment archive from an explicit allowlist; never publish it."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import tarfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "README.md", "pyproject.toml", "requirements.txt",
    "deploy/run.py", "deploy/README.md", "deploy/lele-growth@.service",
    "deploy/nginx.example.conf", "deploy/production.env.example",
    "config/README.md", "config/production.example.json",
    "config/object-storage.example.json", "licenses/Inter-OFL.txt",
    "licenses/shadcn-ui-MIT.txt", "docs/project-structure.md",
    "docs/oss-storage.md",
)


def release_files(root: Path) -> list[Path]:
    files = [root / name for name in FILES]
    for directory, extensions in (
        ("backend/lele_growth", {".py", ".sql"}),
        ("web/parent-dist", {".html", ".js", ".css", ".woff2"}),
        ("web/admin-dist", {".html", ".js", ".css", ".woff2"}),
    ):
        files.extend(file for file in (root / directory).rglob("*")
                     if file.suffix in extensions and "__pycache__" not in file.parts)
    for file in files:
        if not file.is_file() or file.is_symlink() or root not in file.resolve().parents:
            raise ValueError("发布文件缺失或包含链接：" + str(file.relative_to(root)))
    for surface in ("parent", "admin"):
        page = root / "web" / (surface + "-dist") / "index.html"
        if page not in files:
            raise ValueError("必须先构建两个前端。")
    return sorted(set(files))


def package(root: Path, output: Path) -> Path:
    root = root.resolve()
    files = release_files(root)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"lele-growth-{stamp}-{commit[:7]}{'-dirty' if dirty else ''}.tar.gz"
    manifest = {"commit": commit, "workingTreeDirty": dirty, "builtAt": stamp,
                "files": {file.relative_to(root).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest() for file in files}}
    temporary = target.with_suffix(".tmp")
    try:
        with tarfile.open(temporary, "w:gz") as archive:
            for file in files:
                relative = file.relative_to(root).as_posix()
                info = archive.gettarinfo(str(file), arcname=relative)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                with file.open("rb") as source:
                    archive.addfile(info, source)
            data = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
            info = tarfile.TarInfo("release-manifest.json")
            info.size, info.mode = len(data), 0o644
            archive.addfile(info, io.BytesIO(data))
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    target.with_name(target.name + ".sha256").write_text(hashlib.sha256(target.read_bytes()).hexdigest() + "  " + target.name + "\n")
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "output/releases")
    args = parser.parse_args()
    print(package(ROOT, args.output.resolve()))
