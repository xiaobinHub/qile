import unittest
from unittest.mock import Mock
from lele_growth.child_avatars import avatar_catalog, AVATAR_IDS


class AvatarCatalogTests(unittest.TestCase):
    def test_signs_only_curated_private_objects(self):
        objects=Mock(config={'prefix':'lele-growth/development'})
        objects.bucket.sign_url.side_effect=lambda method,key,ttl,**kwargs: 'https://bucket.example/'+key+'?signature=temporary'
        catalog=avatar_catalog(objects)
        self.assertEqual(catalog['expiresIn'],3600)
        self.assertEqual([a['id'] for a in catalog['avatars']],list(AVATAR_IDS))
        for call,avatar_id in zip(objects.bucket.sign_url.call_args_list,AVATAR_IDS):
            self.assertEqual(call.args,('GET',f'lele-growth/development/avatars/clay-500-v1/{avatar_id}.png',3600))
        self.assertEqual(len(catalog['avatars']),20)

    def test_family_avatar_labels_and_private_signatures(self):
        from lele_growth.child_avatars import account_avatar_catalog
        objects=Mock(config={'prefix':'lele-growth/development'})
        objects.bucket.sign_url.return_value='https://bucket.example/image?signature=temporary'
        catalog=account_avatar_catalog(objects)
        self.assertEqual([(a['id'],a['label']) for a in catalog['avatars']],[('father','爸爸'),('mother','妈妈'),('grandfather','爷爷'),('grandmother','奶奶')])
        self.assertEqual(catalog['expiresIn'],3600)
        for call in objects.bucket.sign_url.call_args_list:
            self.assertEqual(call.args[0],'GET')
            self.assertTrue(call.args[1].startswith('lele-growth/development/avatars/family-clay-500-v1/'))
            self.assertEqual(call.args[2],3600)
