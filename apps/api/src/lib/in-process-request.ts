/** Dispatch through the shared router after it has finished initializing. */
export async function inProcessRequest(request: Request): Promise<Response> {
  const { app } = await import("../app");
  return app.fetch(request);
}
