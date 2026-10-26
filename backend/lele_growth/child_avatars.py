"""Curated shared avatars; signing credentials never leave the server."""
DEFAULT_AVATAR = 'boy-04'
CHILD_GENDER_AVATARS = {'boy': DEFAULT_AVATAR, 'girl': 'girl-10'}
AVATAR_IDS = tuple(f'{group}-{number:02d}' for group in ('boy', 'girl') for number in range(1, 11))


def avatar_catalog(objects):
    if objects.bucket is None:
        from lele_growth.child_service import ApiError
        raise ApiError(503, '头像存储尚未配置，请稍后重试。')
    return {'expiresIn': 3600, 'avatars': [
        {'id': avatar_id, 'url': objects.bucket.sign_url('GET',
            f"{objects.config['prefix']}/avatars/clay-500-v1/{avatar_id}.png", 3600, slash_safe=True)}
        for avatar_id in AVATAR_IDS
    ]}

ACCOUNT_AVATARS = (('father','爸爸'), ('mother','妈妈'), ('grandfather','爷爷'), ('grandmother','奶奶'))
ACCOUNT_AVATAR_IDS = tuple(item[0] for item in ACCOUNT_AVATARS)
DEFAULT_ACCOUNT_AVATAR = 'father'


def account_avatar_catalog(objects):
    if objects.bucket is None:
        from lele_growth.child_service import ApiError
        raise ApiError(503, '头像存储尚未配置，请稍后重试。')
    return {'expiresIn': 3600, 'avatars': [
        {'id': avatar_id, 'label': label, 'url': objects.bucket.sign_url('GET',
            f"{objects.config['prefix']}/avatars/family-clay-500-v1/{avatar_id}.png", 3600, slash_safe=True)}
        for avatar_id,label in ACCOUNT_AVATARS
    ]}
