/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { OpenListClient } from '@/lib/openlist.client';
import {
  getCachedMetaInfo,
  invalidateMetaInfoCache,
  MetaInfo,
  setCachedMetaInfo,
} from '@/lib/openlist-cache';
import {
  cleanupOldTasks,
  completeScanTask,
  createScanTask,
  failScanTask,
  updateScanTaskProgress,
} from '@/lib/scan-task';
import { searchTMDB } from '@/lib/tmdb.search';

export const runtime = 'nodejs';

/**
 * POST /api/openlist/refresh
 * 刷新私人影库元数据（后台任务模式）
 */
export async function POST(request: NextRequest) {
  try {
    // 权限检查
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    // 获取配置
    const config = await getConfig();
    const openListConfig = config.OpenListConfig;

    if (!openListConfig || !openListConfig.URL || !openListConfig.Token) {
      return NextResponse.json(
        { error: 'OpenList 未配置' },
        { status: 400 }
      );
    }

    const tmdbApiKey = config.SiteConfig.TMDBApiKey;
    const tmdbProxy = config.SiteConfig.TMDBProxy;

    if (!tmdbApiKey) {
      return NextResponse.json(
        { error: 'TMDB API Key 未配置' },
        { status: 400 }
      );
    }

    // 清理旧任务
    cleanupOldTasks();

    // 创建后台任务
    const taskId = createScanTask();

    // 启动后台扫描
    performScan(
      taskId,
      openListConfig.URL,
      openListConfig.Token,
      openListConfig.RootPath || '/',
      tmdbApiKey,
      tmdbProxy,
      openListConfig.Username,
      openListConfig.Password
    ).catch((error) => {
      console.error('[OpenList Refresh] 后台扫描失败:', error);
      failScanTask(taskId, (error as Error).message);
    });

    return NextResponse.json({
      success: true,
      taskId,
      message: '扫描任务已启动',
    });
  } catch (error) {
    console.error('启动刷新任务失败:', error);
    return NextResponse.json(
      { error: '启动失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}

/**
 * 执行扫描任务
 */
async function performScan(
  taskId: string,
  url: string,
  token: string,
  rootPath: string,
  tmdbApiKey: string,
  tmdbProxy?: string,
  username?: string,
  password?: string
): Promise<void> {
  const client = new OpenListClient(url, token, username, password);

  console.log('[OpenList Refresh] 开始扫描:', {
    taskId,
    rootPath,
    url,
    hasToken: !!token,
  });

  // 立即更新进度，确保任务可被查询
  updateScanTaskProgress(taskId, 0, 0);

  try {
    // 1. 读取现有 metainfo (从数据库或缓存)
    let existingMetaInfo: MetaInfo | null = getCachedMetaInfo(rootPath);

    if (!existingMetaInfo) {
      try {
        console.log('[OpenList Refresh] 尝试从数据库读取 metainfo');
        const metainfoJson = await db.getGlobalValue('video.metainfo');

        if (metainfoJson) {
          existingMetaInfo = JSON.parse(metainfoJson);
          console.log('[OpenList Refresh] 从数据库读取到现有数据:', {
            hasfolders: !!existingMetaInfo?.folders,
            foldersType: typeof existingMetaInfo?.folders,
            videoCount: Object.keys(existingMetaInfo?.folders || {}).length,
          });
        }
      } catch (error) {
        console.error('[OpenList Refresh] 从数据库读取 metainfo 失败:', error);
        console.log('[OpenList Refresh] 将创建新数据');
      }
    } else {
      console.log('[OpenList Refresh] 使用缓存的 metainfo，视频数:', Object.keys(existingMetaInfo.folders).length);
    }

    const metaInfo: MetaInfo = existingMetaInfo || {
      folders: {},
      last_refresh: Date.now(),
    };

    // 确保 folders 对象存在
    if (!metaInfo.folders || typeof metaInfo.folders !== 'object') {
      console.warn('[OpenList Refresh] metaInfo.folders 无效，重新初始化');
      metaInfo.folders = {};
    }

    console.log('[OpenList Refresh] metaInfo 初始化完成:', {
      hasfolders: !!metaInfo.folders,
      foldersType: typeof metaInfo.folders,
      videoCount: Object.keys(metaInfo.folders).length,
    });

    // 2. 列出根目录下的所有文件夹
    const listResponse = await client.listDirectory(rootPath);

    if (listResponse.code !== 200) {
      throw new Error('OpenList 列表获取失败');
    }

    const folders = listResponse.data.content.filter((item) => item.is_dir);

    console.log('[OpenList Refresh] 找到文件夹:', {
      total: folders.length,
      names: folders.map(f => f.name),
    });

    // 更新任务进度
    updateScanTaskProgress(taskId, 0, folders.length);

    // 3. 遍历文件夹，搜索 TMDB
    let newCount = 0;
    let errorCount = 0;

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      console.log('[OpenList Refresh] 处理文件夹:', folder.name);

      // 更新进度
      updateScanTaskProgress(taskId, i + 1, folders.length, folder.name);

      // 跳过已搜索过的文件夹
      if (metaInfo.folders[folder.name]) {
        console.log('[OpenList Refresh] 跳过已存在的文件夹:', folder.name);
        continue;
      }

      try {
        console.log('[OpenList Refresh] 搜索 TMDB:', folder.name);
        // 搜索 TMDB
        const searchResult = await searchTMDB(
          tmdbApiKey,
          folder.name,
          tmdbProxy
        );

        console.log('[OpenList Refresh] TMDB 搜索结果:', {
          folder: folder.name,
          code: searchResult.code,
          hasResult: !!searchResult.result,
        });

        if (searchResult.code === 200 && searchResult.result) {
          const result = searchResult.result;

          metaInfo.folders[folder.name] = {
            tmdb_id: result.id,
            title: result.title || result.name || folder.name,
            poster_path: result.poster_path,
            release_date: result.release_date || result.first_air_date || '',
            overview: result.overview,
            vote_average: result.vote_average,
            media_type: result.media_type,
            last_updated: Date.now(),
            failed: false,
          };

          console.log('[OpenList Refresh] 添加成功:', {
            folder: folder.name,
            title: metaInfo.folders[folder.name].title,
          });

          newCount++;
        } else {
          console.warn(`[OpenList Refresh] TMDB 搜索失败: ${folder.name}`);
          // 记录失败的文件夹
          metaInfo.folders[folder.name] = {
            tmdb_id: 0,
            title: folder.name,
            poster_path: null,
            release_date: '',
            overview: '',
            vote_average: 0,
            media_type: 'movie',
            last_updated: Date.now(),
            failed: true,
          };
          errorCount++;
        }

        // 避免请求过快
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        console.error(`[OpenList Refresh] 处理文件夹失败: ${folder.name}`, error);
        // 记录失败的文件夹
        metaInfo.folders[folder.name] = {
          tmdb_id: 0,
          title: folder.name,
          poster_path: null,
          release_date: '',
          overview: '',
          vote_average: 0,
          media_type: 'movie',
          last_updated: Date.now(),
          failed: true,
        };
        errorCount++;
      }
    }

    // 4. 保存 metainfo 到数据库
    metaInfo.last_refresh = Date.now();

    const metainfoContent = JSON.stringify(metaInfo);
    console.log('[OpenList Refresh] 保存 metainfo 到数据库:', {
      videoCount: Object.keys(metaInfo.folders).length,
      contentLength: metainfoContent.length,
    });

    await db.setGlobalValue('video.metainfo', metainfoContent);
    console.log('[OpenList Refresh] 保存成功');

    // 验证保存：立即读取数据库
    try {
      console.log('[OpenList Refresh] 验证保存：读取数据库');
      const verifyContent = await db.getGlobalValue('video.metainfo');
      if (verifyContent) {
        const verifyParsed = JSON.parse(verifyContent);
        console.log('[OpenList Refresh] 验证解析成功:', {
          hasfolders: !!verifyParsed.folders,
          foldersType: typeof verifyParsed.folders,
          videoCount: Object.keys(verifyParsed.folders || {}).length,
        });
      }
    } catch (verifyError) {
      console.error('[OpenList Refresh] 验证失败:', verifyError);
    }

    // 5. 更新缓存
    invalidateMetaInfoCache(rootPath);
    setCachedMetaInfo(rootPath, metaInfo);
    console.log('[OpenList Refresh] 缓存已更新');

    // 6. 更新配置
    const config = await getConfig();
    config.OpenListConfig!.LastRefreshTime = Date.now();
    config.OpenListConfig!.ResourceCount = Object.keys(metaInfo.folders).length;
    await db.saveAdminConfig(config);

    // 完成任务
    completeScanTask(taskId, {
      total: folders.length,
      new: newCount,
      existing: Object.keys(metaInfo.folders).length - newCount,
      errors: errorCount,
    });

    console.log('[OpenList Refresh] 扫描完成:', {
      taskId,
      total: folders.length,
      new: newCount,
      existing: Object.keys(metaInfo.folders).length - newCount,
      errors: errorCount,
    });
  } catch (error) {
    console.error('[OpenList Refresh] 扫描失败:', error);
    failScanTask(taskId, (error as Error).message);
    throw error;
  }
}
