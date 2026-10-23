"""Offline operator entrypoint; no implicit config, migrations or cloud deployment."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))

if __name__ == '__main__':
    from lele_growth.production_maintenance import main
    main()
