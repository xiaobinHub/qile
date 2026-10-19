"""Explicit FastAPI parent/admin application factories. Import never connects to DB.

Start with: uvicorn 'accounts_app:create_from_env' --factory --host 127.0.0.1
Set LELE_ACCOUNTS_CONFIG to an explicit config and LELE_SURFACE=parent|admin.
"""
from __future__ import annotations
import json
import os
import re
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from child_service import ApiError, ChildService, initialize, bootstrap, import_child, SESSION_SECONDS
from storage import StoreError

MAX_BODY_BYTES = 8 * 1024 * 1024


def reject_json_constant(value):
    raise ValueError('Non-finite JSON numbers are not accepted')


def create_app(config_path, surface='parent'):
    if surface not in ('parent','admin'):
        raise ApiError(503,'服务入口配置无效。')
    service=ChildService(config_path)
    production=service.config['environment']=='production'
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
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='same-origin'
        response.headers['X-Frame-Options']='DENY'
        response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
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
        body_bytes=bytearray()
        async for chunk in request.stream():
            body_bytes.extend(chunk)
            if len(body_bytes)>MAX_BODY_BYTES:
                raise ApiError(413,'提交内容过大。')
        try:
            body=json.loads(body_bytes, parse_constant=reject_json_constant) if body_bytes else {}
        except (ValueError,UnicodeError):
            raise ApiError(400,'请求格式不正确。') from None
        if body_bytes and request.headers.get('content-type','').split(';')[0].strip()!='application/json':
            raise ApiError(415,'请使用 JSON 请求格式。')
        result=await run_in_threadpool(service.request,request.method,path,body,request.cookies.get(cookie_name),request.headers.get('x-csrf-token'),request.headers.get('origin'),surface,request.client.host if request.client else 'unknown')
        token=result.pop('_cookie',None); clear=result.pop('_clear_cookie',False)
        response=JSONResponse(result)
        if token:
            response.set_cookie(cookie_name,token,max_age=SESSION_SECONDS[surface],httponly=True,secure=production,samesite='strict',path='/')
        if clear:
            response.delete_cookie(cookie_name,path='/',httponly=True,secure=production,samesite='strict')
        return response

    web_root=Path(__file__).resolve().parent/'web'
    def page():
        file=web_root/'admin-dist'/'index.html' if surface=='admin' else web_root/'parent.html'
        if not file.is_file(): raise ApiError(503,'页面尚未准备好。')
        return FileResponse(file)

    app.add_api_route('/',page,methods=['GET'])
    if surface=='parent':
        app.add_api_route('/children/{child_id}',page,methods=['GET'])

    @app.get('/static/{asset}')
    def static(asset:str):
        if surface!='parent' or asset not in {'parent.js','parent-settings.js','parent-settings.css','parent-ui.js'}:
            raise ApiError(404,'文件不存在。')
        file=web_root/'parent-dist'/asset if asset=='parent-ui.js' else web_root/asset
        if not file.is_file(): raise ApiError(404,'文件不存在。')
        return FileResponse(file)

    if surface=='admin':
        @app.get('/admin-assets/{asset}')
        def admin_asset(asset:str):
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css)',asset):
                raise ApiError(404,'文件不存在。')
            root=(web_root/'admin-dist').resolve()
            file=(root/asset).resolve()
            if file.parent!=root or not file.is_file():
                raise ApiError(404,'文件不存在。')
            return FileResponse(file)
    return app


def create_from_env():
    path=os.environ.get('LELE_ACCOUNTS_CONFIG')
    if not path: raise ApiError(503,'必须显式指定 LELE_ACCOUNTS_CONFIG。')
    return create_app(path,os.environ.get('LELE_SURFACE','parent'))
