export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('missing url query', { status: 400 });
    }

    const upstream = await fetch(target, {
      headers: {
        'User-Agent': 'public-fair-lottery-drawer/1.0'
      }
    });

    const body = await upstream.text();
    const headers = new Headers(upstream.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
    headers.set('Access-Control-Allow-Headers', '*');

    return new Response(body, {
      status: upstream.status,
      headers
    });
  }
};
