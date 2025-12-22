import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime, getConfig } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  // 特殊处理 openlist 源
  if (sourceCode === 'openlist') {
    try {
      const config = await getConfig();
      const openListConfig = config.OpenListConfig;

      if (!openListConfig || !openListConfig.URL || !openListConfig.Token) {
        throw new Error('OpenList 未配置');
      }

      const rootPath = openListConfig.RootPath || '/';

      // 1. 读取 metainfo 获取元数据
      let metaInfo: any = null;
      try {
        const { getCachedMetaInfo, setCachedMetaInfo } = await import('@/lib/openlist-cache');
        const { getTMDBImageUrl } = await import('@/lib/tmdb.search');
        const { db } = await import('@/lib/db');

        metaInfo = getCachedMetaInfo(rootPath);

        if (!metaInfo) {
          const metainfoJson = await db.getGlobalValue('video.metainfo');
          if (metainfoJson) {
            metaInfo = JSON.parse(metainfoJson);
            setCachedMetaInfo(rootPath, metaInfo);
          }
        }
      } catch (error) {
        console.error('[Detail] 从数据库读取 metainfo 失败:', error);
      }

      // 2. 调用 openlist detail API
      const openlistResponse = await fetch(
        `${request.headers.get('x-forwarded-proto') || 'http'}://${request.headers.get('host')}/api/openlist/detail?folder=${encodeURIComponent(id)}`,
        {
          headers: {
            Cookie: request.headers.get('cookie') || '',
          },
        }
      );

      if (!openlistResponse.ok) {
        throw new Error('获取 OpenList 视频详情失败');
      }

      const openlistData = await openlistResponse.json();

      if (!openlistData.success) {
        throw new Error(openlistData.error || '获取视频详情失败');
      }

      // 3. 从 metainfo 中获取元数据
      const folderMeta = metaInfo?.folders?.[id];
      const { getTMDBImageUrl } = await import('@/lib/tmdb.search');

      // 转换为标准格式（使用懒加载 URL）
      const result = {
        source: 'openlist',
        source_name: '私人影库',
        id: openlistData.folder,
        title: folderMeta?.title || openlistData.folder,
        poster: folderMeta?.poster_path ? getTMDBImageUrl(folderMeta.poster_path) : '',
        year: folderMeta?.release_date ? folderMeta.release_date.split('-')[0] : '',
        douban_id: 0,
        desc: folderMeta?.overview || '',
        episodes: openlistData.episodes.map((ep: any) =>
          `/api/openlist/play?folder=${encodeURIComponent(openlistData.folder)}&fileName=${encodeURIComponent(ep.fileName)}`
        ),
        episodes_titles: openlistData.episodes.map((ep: any) => ep.title || `第${ep.episode}集`),
      };

      console.log('[Detail] result.episodes_titles:', result.episodes_titles);

      return NextResponse.json(result);
    } catch (error) {
      return NextResponse.json(
        { error: (error as Error).message },
        { status: 500 }
      );
    }
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  try {
    const apiSites = await getAvailableApiSites(authInfo.username);
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    const result = await getDetailFromApi(apiSite, id);
    const cacheTime = await getCacheTime();

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Netlify-Vary': 'query',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
