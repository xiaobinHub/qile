"""Explicit FastAPI parent/admin application factories. Import never connects to DB.

Start with: uvicorn 'lele_growth.accounts_app:create_from_env' --factory --host 127.0.0.1
Set LELE_ACCOUNTS_CONFIG to an explicit config and LELE_SURFACE=parent|admin.
"""
from __future__ import annotations
import json
import os
import re
from pathlib import Path

from lele_growth.paths import WEB_ROOT

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from lele_growth.child_service import ApiError, ChildService, initialize, bootstrap, import_child, SESSION_SECONDS
from lele_growth.storage import StoreError
from lele_growth.media_types import ImageResponse, MAX_IMAGE_BYTES

MAX_BODY_BYTES = 8 * 1024 * 1024


def reject_json_constant(value):
    raise ValueError('Non-finite JSON numbers are not accepted')


def create_app(config_path, surface='parent'):
    if surface not in ('parent','admin'):
        raise ApiError(503,'服务入口配置无效。')
    service=ChildService(config_path)
    production=service.config['environment']=='production'
    storage=service.config['_object_storage']
    avatar_origin = f" https://{storage['bucket']}.oss-{storage['region']}.aliyuncs.com" if storage and storage['provider']=='oss' else ''
    cookie_name=('__Host-' if production else '')+'lele_'+surface
    app=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
    app.state.service=service
    app.state.surface=surface

    @app.exception_handler(ApiError)
    async def api_error(request,error):
        content={'error':error.error}
        if error.kind: content['kind']=error.kind
        return JSONResponse(content,status_code=error.status)

    @app.exception_handler(StoreError)
    async def store_error(request,error):
        return JSONResponse({'error':error.message},status_code=int(error.status))

    @app.exception_handler(HTTPException)
    async def http_error(request,error):
        return JSONResponse({'error':'接口不存在。' if error.status_code==404 else '请求无法处理。'},status_code=error.status_code)

    @app.middleware('http')
    async def headers(request,call_next):
        response=await call_next(request)
        response.headers['Cache-Control']='private, no-store' if '/assets/' in request.url.path else 'no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='same-origin'
        response.headers['X-Frame-Options']='DENY'
        response.headers['Content-Security-Policy']=f"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:{avatar_origin}; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        if production: response.headers['Strict-Transport-Security']='max-age=31536000'
        return response

    @app.get('/api/health')
    @app.get('/health')
    def health():
        status={'environment':service.config['environment'],'service':'lele-task-manager','storage':'postgres'}
        try:
            service.transaction(lambda cur: cur.execute('SELECT 1'))
        except (ApiError,StoreError):
            return JSONResponse({**status,'ok':False,'databaseReady':False,'error':'数据库暂时无法访问。'},status_code=503)
        return {**status,'ok':True,'databaseReady':True}

    @app.api_route('/api/{path:path}',methods=['GET','POST','PATCH','DELETE','PUT','OPTIONS'])
    async def api(path:str,request:Request):
        upload=re.fullmatch(r'children/([^/]+)/assets',path) if request.method=='POST' and surface=='parent' else None
        body_bytes=bytearray()
        async for chunk in request.stream():
            body_bytes.extend(chunk)
            if len(body_bytes)>(MAX_IMAGE_BYTES if upload else MAX_BODY_BYTES):
                raise ApiError(413,'提交内容过大。')
        if upload:
            result=await run_in_threadpool(service.media.upload,upload[1],bytes(body_bytes),request.headers.get('content-type','').split(';')[0].strip(),request.headers.get('x-upload-id'),request.headers.get('x-membership-version'),request.cookies.get(cookie_name),request.headers.get('x-csrf-token'),request.headers.get('origin'))
            return JSONResponse(result)
        try:
            body=json.loads(body_bytes, parse_constant=reject_json_constant) if body_bytes else {}
        except (ValueError,UnicodeError):
            raise ApiError(400,'请求格式不正确。') from None
        if body_bytes and request.headers.get('content-type','').split(';')[0].strip()!='application/json':
            raise ApiError(415,'请使用 JSON 请求格式。')
        result=await run_in_threadpool(service.request,request.method,path,body,request.cookies.get(cookie_name),request.headers.get('x-csrf-token'),request.headers.get('origin'),surface,request.client.host if request.client else 'unknown')
        if isinstance(result,ImageResponse):
            return Response(result.content,media_type=result.mime)
        token=result.pop('_cookie',None); clear=result.pop('_clear_cookie',False)
        response=JSONResponse(result)
        if token:
            response.set_cookie(cookie_name,token,max_age=SESSION_SECONDS[surface],httponly=True,secure=production,samesite='strict',path='/')
        if clear:
            response.delete_cookie(cookie_name,path='/',httponly=True,secure=production,samesite='strict')
        return response

    web_root=WEB_ROOT
    def page():
        file=web_root/'admin-dist'/'index.html' if surface=='admin' else web_root/'parent-dist'/'index.html'
        if not file.is_file(): raise ApiError(503,'页面尚未准备好。')
        return FileResponse(file)

    app.add_api_route('/',page,methods=['GET'])
    if surface=='parent':
        app.add_api_route('/children/{child_id}',page,methods=['GET'])

    # Serve only built frontend assets, never source/config or arbitrary paths.
    asset_prefix = '/admin-assets/{asset}' if surface == 'admin' else '/parent-assets/{asset}'
    @app.get(asset_prefix)
    def frontend_asset(asset: str):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css|woff2|png)', asset):
            raise ApiError(404, '文件不存在。')
        root = (web_root / ('admin-dist' if surface == 'admin' else 'parent-dist')).resolve()
        file = (root / asset).resolve()
        if file.parent != root or not file.is_file():
            raise ApiError(404, '文件不存在。')
        return FileResponse(file)
    return app


def create_from_env():
    path=os.environ.get('LELE_ACCOUNTS_CONFIG')
    if not path: raise ApiError(503,'必须显式指定 LELE_ACCOUNTS_CONFIG。')
    return create_app(path,os.environ.get('LELE_SURFACE','parent'))
