"""Repository resources shared by both application surfaces.

Releases run from a source checkout or the deployable source archive, including
the sibling web/ directory. Private configuration is always provided separately.
"""
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = PROJECT_ROOT / "web"
DATABASE_ROOT = Path(__file__).with_name("db")
