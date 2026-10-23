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
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_assets import validate_assets

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "README.md", "pyproject.toml", "requirements.txt",
    "deploy/run.py", "deploy/manage.py", "deploy/migrate_legacy.py", "deploy/README.md", "deploy/lele-growth@.service",
    "deploy/nginx.example.conf", "deploy/production.env.example",
    "config/README.md", "config/production.example.json",
    "config/object-storage.example.json", "licenses/Inter-OFL.txt",
    "licenses/shadcn-ui-MIT.txt", "docs/project-structure.md",
    "docs/oss-storage.md",
)


def release_files(root: Path) -> list[Path]:
    root = root.resolve()
    files = [root / name for name in FILES]
    for directory, extensions in (
        ("backend/lele_growth", {".py", ".sql"}),
        ("web/parent-dist", {".html", ".js", ".css", ".woff2"}),
        ("web/admin-dist", {".html", ".js", ".css", ".woff2"}),
    ):
        files.extend(file for file in (root / directory).rglob("*")
                     if file.suffix in extensions and "__pycache__" not in file.parts)
    for file in files:
        if (not file.is_file() or root not in file.resolve().parents
                or any(p.is_symlink() for p in (file, *file.parents) if p != root)):
            raise ValueError("发布文件缺失或包含链接：" + str(file.relative_to(root)))
    for surface in ("parent", "admin"):
        files.extend(validate_assets(root, surface))
    return sorted(set(files))


def package(root: Path, output: Path, *, allow_dirty=False) -> Path:
    root = root.resolve()
    files = release_files(root)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=root))
    tracked = set(subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split('\0'))
    dirty = dirty or any(file.relative_to(root).as_posix() not in tracked for file in files)
    if dirty and not allow_dirty:
        raise ValueError("正式发布包要求干净且全部已跟踪的工作区；请先提交。仅本地验收可使用 --allow-dirty。")
    # Snapshot bytes once: hashes describe exactly the bytes written to the tar.
    contents = {file.relative_to(root).as_posix(): file.read_bytes() for file in files}
    if not dirty:
        for name, content in contents.items():
            committed = subprocess.check_output(["git", "show", commit + ':' + name], cwd=root)
            if committed != content:
                raise ValueError("打包期间发布文件发生变化，请重新检查工作区。")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"lele-growth-{stamp}-{commit[:7]}{'-dirty' if dirty else ''}.tar.gz"
    manifest = {"commit": commit, "workingTreeDirty": dirty, "builtAt": stamp,
                "purpose": "development" if dirty else "release",
                "files": {name: hashlib.sha256(content).hexdigest() for name, content in contents.items()}}
    temporary = target.with_suffix(".tmp")
    try:
        with tarfile.open(temporary, "w:gz") as archive:
            for relative, content in contents.items():
                info = tarfile.TarInfo(relative)
                info.size = len(content)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(content))
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
    parser.add_argument("--allow-dirty", action="store_true", help="仅供本地验收，生成明确标记的开发包")
    args = parser.parse_args()
    try:
        print(package(ROOT, args.output.resolve(), allow_dirty=args.allow_dirty))
    except ValueError as error:
        parser.exit(1, str(error) + '\n')
