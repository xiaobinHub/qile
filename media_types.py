"""Image limits and reference transforms shared by storage, commands and migration."""
import base64
import binascii
import copy
import hashlib
import io
import re
import warnings
from dataclasses import dataclass
from http import HTTPStatus
from PIL import Image, UnidentifiedImageError
from storage import StoreError

MAX_IMAGE_BYTES = 180 * 1024
ASSET_ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')
MIMES = {'PNG': ('image/png', 'png'), 'JPEG': ('image/jpeg', 'jpg'), 'WEBP': ('image/webp', 'webp')}

@dataclass(frozen=True)
class ImageFile:
    content: bytes
    mime: str
    extension: str
    sha256: str
    width: int
    height: int

@dataclass(frozen=True)
class ImageResponse:
    content: bytes
    mime: str


def invalid(message='图片格式或大小不正确，请重新选择 PNG、JPEG 或 WebP 图片。'):
    raise StoreError(HTTPStatus.BAD_REQUEST, message)


def inspect_image(content, mime=None):
    if not isinstance(content, bytes) or not 0 < len(content) <= MAX_IMAGE_BYTES:
        invalid()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as image:
                actual, ext = MIMES[image.format]
                width, height = image.size
                if width > 8192 or height > 8192 or width * height > 16_000_000 or getattr(image, 'n_frames', 1) != 1:
                    invalid()
                image.verify()
            with Image.open(io.BytesIO(content)) as image:
                image.load()
        if mime is not None and mime.lower() != actual:
            invalid()
    except (KeyError, ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        invalid()
    return ImageFile(content, actual, ext, hashlib.sha256(content).hexdigest(), width, height)


def decode_image(value):
    if not isinstance(value, str) or len(value) > 260000:
        invalid()
    match = re.fullmatch(r'data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})', value, re.I)
    if not match:
        invalid()
    try:
        raw = base64.b64decode(match[2], validate=True)
    except (binascii.Error, ValueError):
        invalid()
    return inspect_image(raw, match[1])


def image_url(child, asset):
    return f'/api/children/{child}/assets/{asset}'


def inline_fields(value):
    """Only actual imageData fields, never arbitrary user text or strings."""
    if isinstance(value, dict):
        image = value.get('imageData')
        if isinstance(image, str) and image:
            yield image
        for key, item in value.items():
            if key != 'imageData':
                yield from inline_fields(item)
    elif isinstance(value, list):
        for item in value:
            yield from inline_fields(item)


def referenced_assets(value):
    if isinstance(value, dict):
        if value.get('imageAssetId') is not None:
            asset = value['imageAssetId']
            if not isinstance(asset, str) or not ASSET_ID.fullmatch(asset):
                invalid('图片引用格式不正确。')
            yield asset
        for item in value.values():
            yield from referenced_assets(item)
    elif isinstance(value, list):
        for item in value:
            yield from referenced_assets(item)


def transform_images(value, store_image):
    result = copy.deepcopy(value)
    def visit(node):
        if isinstance(node, dict):
            if 'imageData' in node:
                image = node.pop('imageData')
                if image:
                    node['imageAssetId'] = store_image(decode_image(image))
            if 'imageAssetId' in node:
                node.pop('imageUrl', None)
            for item in node.values():
                visit(item)
        elif isinstance(node, list):
            for item in node:
                visit(item)
    visit(result)
    return result
