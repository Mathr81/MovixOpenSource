import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

async function loadRoutingModule() {
  const sourceUrl = new URL('../src/injection/mediaProxyRouting.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceUrl.pathname,
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
  return import(dataUrl);
}

test('routes protected HLS and direct media entry URLs to the local proxy', async () => {
  const { isLocalMediaProxyCandidate } = await loadRoutingModule();

  for (const url of [
    'https://u14.vidzy.cc/hls/movie/master.m3u8?token=abc',
    'https://r1.fsvid.lol/hls/movie/segment.ts',
    'https://cdn.example/video/v.mp4?token=abc',
  ]) {
    assert.equal(isLocalMediaProxyCandidate({
      url,
      method: 'GET',
      responseType: 'arraybuffer',
      headers: {
        Referer: 'https://vidzy.org/',
        Origin: 'https://vidzy.org',
      },
    }), true, url);
  }
});

test('matches protected headers case-insensitively', async () => {
  const { isLocalMediaProxyCandidate } = await loadRoutingModule();

  assert.equal(isLocalMediaProxyCandidate({
    url: 'https://free.finepulfe.xyz/movie/master.m3u8',
    method: 'get',
    responseType: 'arraybuffer',
    headers: {
      referer: 'https://purstream.mx/',
      origin: 'https://purstream.mx',
    },
  }), true);
});

test('routes Seek media but not its extraction API', async () => {
  const { isLocalMediaProxyCandidate: shouldUseMediaProxy } =
    await loadRoutingModule();

  assert.equal(shouldUseMediaProxy({
    url: 'https://185.237.106.181/v4/token/master.m3u8?v=1',
    method: 'GET',
    headers: {
      Origin: 'https://movix1.embedseek.com',
      Referer: 'https://movix1.embedseek.com/',
    },
  }), true);

  assert.equal(shouldUseMediaProxy({
    url: 'https://movix1.embedseek.com/api/v1/video?id=ug3i',
    method: 'GET',
    headers: {
      Origin: 'https://movix1.embedseek.com',
      Referer: 'https://movix1.embedseek.com/',
    },
  }), false);
});

test('keeps extraction pages, APIs, posts, and unprotected media on GM_FETCH', async () => {
  const { isLocalMediaProxyCandidate } = await loadRoutingModule();

  const requests = [
    {
      url: 'https://vidzy.org/embed-id.html',
      method: 'GET',
      headers: { Referer: 'https://vidzy.org/' },
    },
    {
      url: 'https://api.movix.show/api/purstream/movie/550/stream',
      method: 'GET',
      headers: { Origin: 'https://movix.show' },
    },
    {
      url: 'https://u14.vidzy.cc/hls/movie/master.m3u8',
      method: 'POST',
      headers: { Referer: 'https://vidzy.org/' },
    },
    {
      url: 'https://cdn.example/movie/master.m3u8',
      method: 'GET',
      headers: { Accept: '*/*' },
    },
    {
      url: 'http://127.0.0.1:28123/p/session',
      method: 'GET',
      headers: { Referer: 'https://vidzy.org/' },
    },
  ];

  for (const request of requests) {
    assert.equal(isLocalMediaProxyCandidate(request), false, request.url);
  }
});
