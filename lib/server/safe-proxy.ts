import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_MAX_REDIRECTS = 3;

export class SafeProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'SafeProxyError';
  }
}

function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return null;

  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>>
    0
  );
}

function isIpv4InRange(value: number, start: string, end: string): boolean {
  const startValue = parseIpv4(start);
  const endValue = parseIpv4(end);
  return (
    startValue !== null &&
    endValue !== null &&
    value >= startValue &&
    value <= endValue
  );
}

function isBlockedIpv4(value: string): boolean {
  const address = parseIpv4(value);
  if (address === null) return true;

  const first = (address >>> 24) & 0xff;
  const second = (address >>> 16) & 0xff;
  const third = (address >>> 8) & 0xff;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224 ||
    isIpv4InRange(address, '192.88.99.0', '192.88.99.255')
  );
}

function parseIpv6(value: string): bigint | null {
  let normalized = value.toLowerCase();

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) return null;

    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const sections = normalized.split('::');
  if (sections.length > 2) return null;

  const head = sections[0] ? sections[0].split(':') : [];
  const tail = sections.length === 2 && sections[1] ? sections[1].split(':') : [];
  const zeroCount = sections.length === 2 ? 8 - head.length - tail.length : 0;

  if (zeroCount < 0 || (sections.length === 1 && head.length !== 8)) {
    return null;
  }

  const groups = [
    ...head,
    ...Array.from({ length: zeroCount }, () => '0'),
    ...tail
  ];

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }

  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(parseInt(group, 16)),
    0n
  );
}

function isIpv6InRange(address: bigint, prefix: bigint, prefixLength: number) {
  if (prefixLength === 0) return true;
  const shift = 128n - BigInt(prefixLength);
  return (address >> shift) === (prefix >> shift);
}

function isBlockedIpv6(value: string): boolean {
  const address = parseIpv6(value);
  if (address === null) return true;

  const mappedIpv4Prefix = address >> 32n;
  if (mappedIpv4Prefix === 0xffffn) {
    const mappedIpv4 = Number(address & 0xffffffffn);
    return isBlockedIpv4(
      `${(mappedIpv4 >>> 24) & 0xff}.${(mappedIpv4 >>> 16) & 0xff}.${
        (mappedIpv4 >>> 8) & 0xff
      }.${mappedIpv4 & 0xff}`
    );
  }

  const privatePrefix = parseIpv6('fc00::');
  const linkLocalPrefix = parseIpv6('fe80::');
  const multicastPrefix = parseIpv6('ff00::');
  const documentationPrefix = parseIpv6('2001:db8::');
  const teredoPrefix = parseIpv6('2001::');

  return (
    address === 0n ||
    address === 1n ||
    (privatePrefix !== null && isIpv6InRange(address, privatePrefix, 7)) ||
    (linkLocalPrefix !== null && isIpv6InRange(address, linkLocalPrefix, 10)) ||
    (multicastPrefix !== null && isIpv6InRange(address, multicastPrefix, 8)) ||
    (documentationPrefix !== null &&
      isIpv6InRange(address, documentationPrefix, 32)) ||
    (teredoPrefix !== null && isIpv6InRange(address, teredoPrefix, 32))
  );
}

function isBlockedAddress(address: string): boolean {
  return isIP(address) === 4
    ? isBlockedIpv4(address)
    : isIP(address) === 6
      ? isBlockedIpv6(address)
      : true;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home.arpa') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.invalid') ||
    normalized.endsWith('.example')
  );
}

export async function validateProxyTarget(rawUrl: string): Promise<URL> {
  if (!rawUrl || rawUrl.length > 2048) {
    throw new SafeProxyError('Invalid proxy URL', 400);
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new SafeProxyError('Invalid proxy URL', 400);
  }

  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    (target.port && !['80', '443'].includes(target.port)) ||
    isBlockedHostname(target.hostname)
  ) {
    throw new SafeProxyError('Proxy target is not allowed', 400);
  }

  try {
    const addresses = await lookup(target.hostname, {
      all: true,
      verbatim: true
    });

    if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
      throw new SafeProxyError('Proxy target is not allowed', 400);
    }
  } catch (error) {
    if (error instanceof SafeProxyError) throw error;
    throw new SafeProxyError('Could not resolve proxy target', 400);
  }

  return target;
}

type SafeFetchOptions = {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  headers?: HeadersInit;
};

type SafeFetchResult = {
  response: Response;
  body: Uint8Array;
  url: URL;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function readResponseBody(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SafeProxyError('Upstream response is too large', 413);
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new SafeProxyError('Upstream response is too large', 413);
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new SafeProxyError('Upstream response is too large', 413);
    }

    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

export async function fetchSafeUrl(
  rawUrl: string,
  options: SafeFetchOptions
): Promise<SafeFetchResult> {
  let target = await validateProxyTarget(rawUrl);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(target, {
        headers: options.headers,
        redirect: 'manual',
        signal: controller.signal
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new SafeProxyError('Upstream redirect is invalid', 502);
        }

        try {
          target = await validateProxyTarget(new URL(location, target).toString());
        } catch (error) {
          if (error instanceof SafeProxyError) throw error;
          throw new SafeProxyError('Upstream redirect is invalid', 502);
        }

        await response.body?.cancel();
        continue;
      }

      if (!response.ok) {
        throw new SafeProxyError('Upstream request failed', 502);
      }

      const body = await readResponseBody(response, options.maxBytes);
      return { response, body, url: target };
    } catch (error) {
      if (error instanceof SafeProxyError) throw error;
      if (controller.signal.aborted) {
        throw new SafeProxyError('Upstream request timed out', 504);
      }
      throw new SafeProxyError('Upstream request failed', 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new SafeProxyError('Too many upstream redirects', 502);
}
