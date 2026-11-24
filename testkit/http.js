import http from "http";

export const startServer = async (t, handler) => {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push({ url: request.url, headers: request.headers });
    handler(request, response, hits.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
};

export const sendBuffer = (response, buffer, headers = {}) => {
  response.writeHead(200, { "content-length": buffer.length, "content-type": "application/zip", ...headers });
  response.end(buffer);
};
