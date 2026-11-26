import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import type { operations } from "../src/app/api.generated";

type Ref = { $ref: string };
type Schema = Record<string, unknown>;
type Content = { content?: { "application/json": { schema: Schema } } };
type Body = Content & { required?: boolean };
type Parameter = { name: string; in: "query" | "path"; required?: boolean; schema: Schema };
type Operation = {
  operationId: keyof operations;
  parameters?: (Parameter | Ref)[];
  requestBody?: Body | Ref;
  responses: Record<string, Content | Ref>;
};
type PathItem = Partial<Record<"get" | "post" | "patch" | "delete", Operation>>
  & { parameters?: (Parameter | Ref)[] };
type Document = { paths: Record<string, PathItem> };

const document = parse(readFileSync(new URL("../../api/openapi.yml", import.meta.url), "utf8")) as Document;
const schemaId = "https://pilot.test/openapi";
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(document, schemaId);

function resolve<T>(value: T | Ref): T {
  if (typeof value === "object" && value !== null && "$ref" in value) {
    assert.ok(value.$ref.startsWith("#/"), "Expected a local OpenAPI reference");
    return value.$ref.slice(2).split("/").reduce<unknown>((current, key) => {
      return (current as Record<string, unknown>)[key];
    }, document) as T;
  }
  return value;
}

function rebaseReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebaseReferences);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key, key === "$ref" ? schemaId + child : rebaseReferences(child),
  ]));
}

function validate(schema: Schema, value: unknown, label: string) {
  const check = ajv.compile(rebaseReferences(schema) as Schema);
  assert.ok(check(value), `${label}: ${ajv.errorsText(check.errors)}`);
}

export type Exchange = {
  operation: keyof operations;
  path?: Record<string, string>;
  query?: Record<string, string>;
  cookie?: string;
  csrf?: string;
  body?: unknown;
  status: number;
  reply?: unknown;
  setCookies?: string[];
};

const methods = ["get", "post", "patch", "delete"] as const;
const endpoints = Object.entries(document.paths).flatMap(([template, item]) =>
  methods.flatMap((method) => {
    const operation = item[method];
    return operation ? [{ template, method: method.toUpperCase(), operation, parameters: item.parameters ?? [] }] : [];
  }));
const route = (template: string, path?: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(path?.[key] ?? ""));

async function verify(request: IncomingMessage, exchange: Exchange, url: URL) {
  const { operation, parameters: inherited } = endpoints.find(({ operation }) => operation.operationId === exchange.operation)!;
  assert.equal(request.headers.cookie, exchange.cookie);
  assert.equal(request.headers["x-csrf-token"], exchange.csrf);

  const query = Object.fromEntries(url.searchParams);
  assert.equal(url.searchParams.size, Object.keys(query).length, "Repeated query parameter");
  assert.deepEqual(query, exchange.query ?? {});
  const parameters = [...(operation.parameters ?? []), ...inherited].map((parameter) => resolve<Parameter>(parameter));
  for (const [location, values] of [["query", query], ["path", exchange.path ?? {}]] as const) {
    for (const [key, value] of Object.entries(values)) {
      const parameter = parameters.find(({ name, in: where }) => name === key && where === location);
      assert.ok(parameter, `Undocumented ${location} parameter ${key}`);
      validate(parameter.schema, value, key);
    }
    for (const parameter of parameters.filter((item) => item.in === location && item.required)) {
      assert.ok(Object.hasOwn(values, parameter.name), `Missing parameter ${parameter.name}`);
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const bodySpec = operation.requestBody && resolve<Body>(operation.requestBody);
  if (body) {
    assert.equal(request.headers["content-type"], "application/json");
    assert.ok(bodySpec?.content, "Undocumented request body");
    const payload: unknown = JSON.parse(body);
    validate(bodySpec.content["application/json"].schema, payload, "Request body");
    assert.deepEqual(payload, exchange.body);
  } else {
    assert.ok(!bodySpec?.required, "Missing request body");
    assert.equal(exchange.body, undefined);
  }

  const response = operation.responses[exchange.status];
  assert.ok(response, `Undocumented response status ${exchange.status}`);
  const content = resolve<Content>(response).content;
  if (content) validate(content["application/json"].schema, exchange.reply, "Mock response body");
  else assert.equal(exchange.reply, undefined);
}

export async function contractBackend() {
  const pending: Exchange[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const index = pending.findIndex((exchange) => endpoints.some(({ template, method, operation }) =>
        operation.operationId === exchange.operation && method === request.method
        && url.pathname === "/api" + route(template, exchange.path)));
      assert.notEqual(index, -1, `Unexpected API request ${request.method} ${url.pathname}`);
      const [exchange] = pending.splice(index, 1);
      await verify(request, exchange, url);
      response.statusCode = exchange.status;
      response.setHeader("Cache-Control", "no-store");
      if (exchange.setCookies) response.setHeader("Set-Cookie", exchange.setCookies);
      if (exchange.reply !== undefined) response.setHeader("Content-Type", "application/json");
      response.end(exchange.reply === undefined ? undefined : JSON.stringify(exchange.reply));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    expect(exchanges: Exchange[]) { pending.push(...exchanges); },
    assertComplete() {
      if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
      assert.deepEqual(pending.map(({ operation }) => operation), []);
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
