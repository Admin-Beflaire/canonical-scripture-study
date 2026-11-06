/** Scaffold only. Authentication and evidence routes are added before deployment. */
export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Study is not implemented.", { status: 501 });
  },
};
