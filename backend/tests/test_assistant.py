import json

import pytest

from app import assistant
from app.assistant import Change, Proposal, check_changes
from app.catalogs import SYNTHETIC
from app.schemas import PlanInput, Scenario, Task


def sample():
    return PlanInput(scenarios=[Scenario(name="问答",components=[Task(id="component",model_id=SYNTHETIC["id"],online_users=100)])])


@pytest.mark.parametrize("field,value",[("__class__","evil"),("model_id","not-in-catalog"),("online_users",-1)])
def test_proposals_cannot_escape_schema(field,value):
    proposal=Proposal(base_revision=1,changes=[Change(entity_id="component",field=field,value=value)])
    with pytest.raises(ValueError):
        check_changes(proposal,sample(),[SYNTHETIC])


def test_connected_adapter_json_and_safe_numeric_explanation(monkeypatch):
    captured={}
    class Response:
        def raise_for_status(self): pass
        def json(self):
            payload={"base_revision":99,"changes":[{"entity_id":"component","field":"online_users","value":200,"reason":"用户明确指令"}],"questions":[],"explanation":"结果需要99P"}
            return {"choices":[{"message":{"content":json.dumps(payload)}}]}
    class Client:
        def __init__(self,**kwargs): pass
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def post(self,url,headers,json):
            captured["url"]=url
            captured["body"]=json
            return Response()
    monkeypatch.setattr(assistant.httpx,"Client",Client)
    result=assistant.ask_provider({"endpoint":"https://example.invalid/chat","model":"structured-model"},"", "全部设为200人在线",sample(),7,[SYNTHETIC])
    assert result.base_revision==7
    assert result.changes[0].value==200
    assert "99" not in result.explanation
    assert captured["body"]["response_format"]=={"type":"json_object"}
