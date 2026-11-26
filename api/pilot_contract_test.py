"""Проверка ответов запущенного API пилота по OpenAPI 3.1."""

import json
import os
from http.cookies import SimpleCookie
from pathlib import Path
from unittest import TestCase, main
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import yaml
from jsonschema import Draft202012Validator


CONTRACT = yaml.safe_load(Path(__file__).with_name("openapi.yml").read_text(encoding="utf-8"))
API = os.environ.get("PILOT_API_URL", "http://localhost:8080/api").rstrip("/")


class Client:
    def __init__(self, case):
        self.case = case
        self.cookies = SimpleCookie()

    def call(self, method, template, status, body=None, *, suffix="", params=None):
        target = template.format(**(params or {})) + suffix
        headers = {"Accept": "application/json"}
        if method != "GET":
            headers["X-CSRF-Token"] = self.call("GET", "/csrf", 200)["token"]
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{key}={cookie.value}" for key, cookie in self.cookies.items())
        data = None if body is None else json.dumps(body).encode()
        request = Request(API + target, data=data, headers=headers, method=method)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            payload = response.read()
            self.case.assertEqual(response.status, status, f"{method} {template}: {payload!r}" if status >= 400 else
                                  f"{method} {template}: неожиданный HTTP-статус")
            self.case.assertIn("no-store", response.headers.get("Cache-Control", ""))
            for cookie_header in response.headers.get_all("Set-Cookie", []):
                cookie = SimpleCookie(cookie_header)
                for name, morsel in cookie.items():
                    self.case.assertTrue(morsel["secure"] and morsel["httponly"])
                    self.case.assertEqual(morsel["path"], "/")
                    self.case.assertEqual(morsel["samesite"].lower(), "lax")
                    if morsel["max-age"] == "0":
                        self.cookies.pop(name, None)
                    else:
                        self.cookies[name] = morsel.value
            documented = CONTRACT["paths"][template][method.lower()]["responses"][str(status)]
            if "$ref" in documented:
                documented = CONTRACT["components"]["responses"][documented["$ref"].split("/")[-1]]
            if "content" not in documented:
                self.case.assertEqual(payload, b"")
                return None
            self.case.assertEqual(response.headers.get_content_type(), "application/json")
            schema = documented["content"]["application/json"]["schema"]
            value = json.loads(payload)
            validator = Draft202012Validator({"components": CONTRACT["components"], **schema},
                                             format_checker=Draft202012Validator.FORMAT_CHECKER)
            errors = list(validator.iter_errors(value))
            self.case.assertFalse(errors, f"{method} {template} {status}: {errors}")
            return value

    def login(self, login, password, status=200):
        return self.call("POST", "/session", status, {"login": login, "password": password})

    def password(self, temporary, password):
        self.call("POST", "/me/password", 204, {"currentPassword": temporary, "newPassword": password})

    def action(self, proposal, action, status=200, comment=None):
        body = {"versionId": proposal["versionId"], "expectedRevision": proposal["revision"]}
        if comment is not None:
            body["comment"] = comment
        return self.call("POST", "/risks/{id}/draft/{action}", status, body,
                         params={"id": proposal["riskId"], "action": action})


class PilotContractTest(TestCase):
    def test_pilot_responses_match_openapi(self):
        admin = Client(self)
        login = os.environ["PILOT_ADMIN_LOGIN"]
        password = os.environ["PILOT_ADMIN_PASSWORD"]
        self.assertTrue(admin.login(login, password)["isAdmin"])
        admin.call("GET", "/me", 200)
        self.assertEqual(admin.call("POST", "/session", 403, {"login": login, "password": "неверный пароль"})["code"],
                         "CSRF_REJECTED")

        suffix = uuid4().hex[:8]
        author = Client(self)
        reviewer = Client(self)
        temporary_passwords = []
        participant_ids = []
        for name, is_reviewer, client in [("author", False, author), ("reviewer", True, reviewer)]:
            participant_login = f"contract-{name}-{suffix}"
            issued = admin.call("POST", "/admin/accounts", 201, {
                "login": participant_login, "displayName": f"{name} {suffix}", "isReviewer": is_reviewer,
            })
            temporary = issued["temporaryPassword"]
            temporary_passwords.append(temporary)
            participant_ids.append(issued["account"]["id"])
            self.assertTrue(client.login(participant_login, temporary)["mustChangePassword"])
            self.assertEqual(client.call("GET", "/me", 403)["code"], "PASSWORD_CHANGE_REQUIRED")
            client.password(temporary, f"Test participant password {suffix}!")
            self.assertFalse(client.call("GET", "/me", 200)["mustChangePassword"])
        self.assertNotEqual(*temporary_passwords)
        admin.call("GET", "/admin/accounts", 200)
        author.call("GET", "/admin/accounts", 403)
        author.call("GET", "/participants", 200)

        draft = author.call("POST", "/risks", 201, {
            "title": f"Контрактный риск {suffix}", "cause": "Ручная проверка", "possibleEvent": "Задержка",
            "productConsequences": "Пользователь ждёт", "likelihood": 3, "impact": 9,
        })
        params = {"id": draft["riskId"]}
        for endpoint in ("/risks/{id}/draft", "/risks/{id}/history", "/risks/{id}"):
            self.assertEqual(reviewer.call("GET", endpoint, 404, params=params)["code"], "NOT_FOUND")
        submitted = author.action(draft, "submit")
        reviewer.call("GET", "/risks", 200, suffix="?view=review")
        reviewer.call("GET", "/risks/{id}/draft", 200, params=params)
        returned = reviewer.action(submitted, "return", comment="Уточните обязательство")
        self.assertEqual(reviewer.action(submitted, "approve", 409)["code"], "RISK_CONFLICT")
        corrected = author.call("PATCH", "/risks/{id}/draft", 200, {
            "versionId": returned["versionId"], "expectedRevision": returned["revision"],
            "fields": {"decisionNote": "Владелец проверит очередь в пятницу."},
        }, params=params)
        published = reviewer.action(author.action(corrected, "submit"), "approve")
        author.call("GET", "/risks", 200, suffix="?view=mine")
        author.call("GET", "/risks", 200, suffix="?view=active")

        expected = {"expectedPublishedVersionId": published["versionId"]}
        edit = author.call("POST", "/risks/{id}/draft", 201, expected, params=params)
        updated = author.call("PATCH", "/risks/{id}/draft", 200, {
            "versionId": edit["versionId"], "expectedRevision": edit["revision"],
            "fields": {"title": "Конфиденциальная правка"},
        }, params=params)
        reviewer.call("GET", "/risks/{id}/draft", 404, params=params)
        review_card = reviewer.call("GET", "/risks/{id}", 200, params=params)
        self.assertEqual(review_card["unblock"], {
            "versionId": updated["versionId"], "revision": updated["revision"],
            "authorDisplayName": draft["author"]["displayName"],
        })
        self.assertNotIn("Конфиденциальная правка", str(review_card))
        author_card = author.call("GET", "/risks/{id}", 200, params=params)
        self.assertNotIn("unblock", author_card)
        self.assertTrue(author_card["hasOpenDraft"])
        self.assertEqual(author.call("POST", "/risks/{id}/draft", 409, expected, params=params)["code"], "RISK_CONFLICT")
        reviewer.call("POST", "/risks/{id}/assessment/confirm", 200, expected, params=params)
        reviewer.action(review_card["unblock"] | {"riskId": draft["riskId"]}, "unblock", comment="Освободить карточку")
        history = author.call("GET", "/risks/{id}/history", 200, params=params)
        self.assertEqual(history["events"][-1]["comment"], "Освободить карточку")
        self.assertEqual(len(history["publishedVersions"]), 1)
        self.assertNotIn("Конфиденциальная правка", str(history))
        reviewer.call("GET", "/risks", 200, suffix="?view=archive")

        reviewer_params = {"id": participant_ids[1]}
        admin.call("PATCH", "/admin/accounts/{id}", 200, {"isReviewer": False}, params=reviewer_params)
        reviewer.call("GET", "/me", 401)
        reset = admin.call("POST", "/admin/accounts/{id}/reset-password", 200, params=reviewer_params)
        self.assertTrue(reset["account"]["mustChangePassword"])
        self.assertNotEqual(reset["temporaryPassword"], temporary_passwords[1])
        author.call("DELETE", "/session", 204)
        author.call("GET", "/me", 401)


if __name__ == "__main__":
    main()
