import { upstream } from "../../upstream";

async function forward(request: Request) {
  const { pathname, search } = new URL(request.url);
  const headers = new Headers();
  for (const name of ["accept", "content-type", "x-csrf-token"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await upstream(pathname + search, {
      method: request.method,
      headers,
      signal: request.signal,
      body: request.body ? await request.arrayBuffer() : undefined,
    }, request.headers);
    const outgoing = new Headers({ "Cache-Control": "no-store" });
    for (const name of ["content-type", "retry-after", "allow"]) {
      const value = response.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    for (const cookie of response.headers.getSetCookie()) outgoing.append("set-cookie", cookie);
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch {
    return Response.json({ message: "Не удалось связаться с сервером. Повторите попытку." }, {
      status: 502, headers: { "Cache-Control": "no-store" },
    });
  }
}

export { forward as GET, forward as POST, forward as PATCH, forward as DELETE };
