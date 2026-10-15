"""Production process entrypoint. No schema initialization or data migration."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

if __name__ == '__main__':
    from accounts_app import create_app
    import uvicorn
    config = os.environ.get('LELE_ACCOUNTS_CONFIG')
    surface = os.environ.get('LELE_SURFACE')
    if not config or surface not in ('parent', 'admin'):
        raise SystemExit('Explicit production configuration and parent/admin surface required.')
    app = create_app(config, surface)
    if app.state.service.config['environment'] != 'production':
        raise SystemExit('Production entrypoint requires production configuration.')
    uvicorn.run(app, host='127.0.0.1', port=8787 if surface == 'parent' else 8788,
                proxy_headers=True, forwarded_allow_ips='127.0.0.1', access_log=True)
