/** Scaffold only. Authentication and task routes are added before deployment. */
export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Maintenance Control is not implemented.", { status: 501 });
  },
};
