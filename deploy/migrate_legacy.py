"""Authorized one-time production data migration; never used by web requests."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))

if __name__ == '__main__':
    from lele_growth.legacy_migration import main
    main()
