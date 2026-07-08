import { md5 } from './utils/md5';

export enum GameTypeEnum {
  FRUIT_PICKING = 'FRUIT_PICKING'
}

export enum SourceEnum {
  WECHAT = 'WECHAT',
  DOUYIN = 'DOUYIN'
}

let BASE_URL = 'https://game.sniper.net.cn' // 默认生产环境

// 自动识别小游戏环境切换域名
try {
  if (typeof wx !== 'undefined' && wx.getAccountInfoSync) {
    const envVersion = wx.getAccountInfoSync().miniProgram.envVersion;
    if (envVersion === 'develop' || envVersion === 'trial') {
      BASE_URL = 'https://test.game.sniper.net.cn'; // 开发版或体验版使用测试环境
    }
  } else if (typeof tt !== 'undefined' && tt.getEnvInfoSync) {
    const envVersion = tt.getEnvInfoSync().microapp.envType;
    if (envVersion === 'development' || envVersion === 'preview') {
      BASE_URL = 'https://test.game.sniper.net.cn'; // 抖音开发版或预览版使用测试环境
    }
  }
} catch (e) {
  console.warn('获取环境版本失败，默认使用生产环境', e);
}

interface ApiResponse<T = any> {
  code: number
  data: T
  message?: string
}

declare const wx: any;
declare const tt: any;

const platform = typeof tt !== 'undefined' ? tt : (typeof wx !== 'undefined' ? wx : null);
const currentSource = typeof tt !== 'undefined' ? SourceEnum.DOUYIN : (typeof wx !== 'undefined' ? SourceEnum.WECHAT : SourceEnum.WECHAT);

const SECRET_KEY = "X9vP2xL5mN8qR1sT4wY7zB0cJ3fH6gD9";

let token: string | null = null;
let currentLevel = 1;

try {
    if (platform) {
        token = platform.getStorageSync('token') || null;
    }
} catch (e) {}

const request = async <T = any>(options: any, isRetry: boolean = false): Promise<ApiResponse<T>> => {
  const doRequest = (): Promise<ApiResponse<T>> => {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.header || {})
      }
      
      if (!token) {
        if (platform) {
          token = platform.getStorageSync('token') || null;
        } else {
          token = localStorage.getItem('token') || null;
        }
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      // 生成签名
      const timestampStr = Date.now().toString();
      headers['X-Timestamp'] = timestampStr;
      
      let bodyStr = "";
      if (options.data) {
        bodyStr = JSON.stringify(options.data);
      }
      const strToSign = bodyStr + timestampStr + SECRET_KEY;
      headers['X-Sign'] = md5(strToSign);

      if (!platform) {
          fetch(BASE_URL + options.url, {
              method: options.method || 'GET',
              headers: headers,
              body: options.data ? JSON.stringify(options.data) : undefined
          })
          .then(async res => {
              if (res.status === 401) {
                  reject({ status: 401, message: 'Unauthorized' });
                  return;
              }
              return res.json();
          })
          .then(data => {
              if (!data) return; // 401 已经 reject
              if (data.code === 200) {
                  resolve(data)
              } else if (data.code === 401) {
                  reject({ status: 401, message: data.message || 'Unauthorized' });
              } else {
                  reject(new Error(data.message || '请求失败'))
              }
          })
          .catch(reject);
          return;
      }

      platform.request({
        ...options,
        url: BASE_URL + options.url,
        header: headers,
        success: (res: any) => {
          if (res.statusCode === 401) {
            reject({ status: 401, message: 'Unauthorized' });
            return;
          }
          const data = res.data as ApiResponse<T>
          if (data.code === 200) {
            resolve(data)
          } else if (data.code === 401) {
            reject({ status: 401, message: data.message || 'Unauthorized' });
          } else {
            reject(new Error(data.message || '请求失败'))
          }
        },
        fail: (err: any) => {
          reject(err)
        }
      })
    });
  };

  try {
    return await doRequest();
  } catch (err: any) {
    if (err && err.status === 401 && !isRetry) {
      console.log('[API] 401 Unauthorized, cleaning token and retrying login...');
      // 清空过期 Token
      token = null;
      if (platform) {
        platform.removeStorageSync('token');
      } else {
        localStorage.removeItem('token');
      }
      
      // 重新静默登录
      await loginAndGetProgress();
      
      // 携带新 Token 重试原请求
      return await request<T>(options, true);
    }
    throw err;
  }
}

export const getLocalLevel = (): number => {
  return currentLevel
}

export const setLocalLevel = (levelNum: number) => {
  currentLevel = Math.max(1, Number(levelNum) || 1)
}

export const loginAndGetProgress = async (): Promise<number> => {
  try {
    let code = "browser_mock_code";
    
    if (platform) {
        const loginRes = await new Promise<any>((resolve, reject) => {
          platform.login({
            success: resolve,
            fail: reject
          })
        });
        code = loginRes.code;
        console.log('[API] wx.login success, code:', code);
    }

    const res = await request<{ token: string; source: SourceEnum; hasProfile: boolean; progress: { gameType: GameTypeEnum; levelNum: number } }>({
      url: '/api/game/login',
      method: 'POST',
      data: {
        code: code,
        gameType: GameTypeEnum.FRUIT_PICKING,
        source: currentSource
      }
    });
    console.log('[API] login response, levelNum:', res.data?.progress?.levelNum, 'hasProfile:', res.data?.hasProfile);
    token = res.data.token;
    if (token) {
        if (platform) {
            platform.setStorageSync('token', token);
            platform.setStorageSync('hasProfile', res.data?.hasProfile);
        } else {
            localStorage.setItem('token', token);
            localStorage.setItem('hasProfile', String(res.data?.hasProfile));
        }
    }

    const serverLevel = res.data.progress?.levelNum || 1;
    setLocalLevel(serverLevel);
    return serverLevel;
  } catch (e) {
    console.error("[API] Login failed:", e);
    
    // 登录失败时，尝试用本地缓存的旧 token 恢复进度
    if (platform) {
        const cachedToken = platform.getStorageSync('token');
        if (cachedToken) {
            token = cachedToken;
            console.log('[API] fallback with cached token');
            // 用旧 token 重新走一次登录（后端会识别已注册用户并返回进度）
            try {
                const loginRes = await new Promise<any>((resolve, reject) => {
                    platform.login({ success: resolve, fail: reject });
                });
                const res = await request<{ token: string; hasProfile: boolean; progress: { levelNum: number } }>({
                    url: '/api/game/login',
                    method: 'POST',
                    data: {
                        code: loginRes.code,
                        gameType: GameTypeEnum.FRUIT_PICKING,
                        source: currentSource
                    }
                });
                token = res.data.token;
                if (token) {
                    platform.setStorageSync('token', token);
                    platform.setStorageSync('hasProfile', res.data?.hasProfile);
                }
                const serverLevel = res.data.progress?.levelNum || 1;
                setLocalLevel(serverLevel);
                console.log('[API] fallback success, level:', serverLevel);
                return serverLevel;
            } catch (fallbackErr) {
                console.error('[API] fallback also failed:', fallbackErr);
            }
        }
    }
    
    return getLocalLevel();
  }
}

export const saveProgress = async (levelNum: number): Promise<void> => {
  setLocalLevel(levelNum)

  try {
    let hasToken = false;
    if (platform) {
        hasToken = !!token || !!platform.getStorageSync('token');
    } else {
        hasToken = !!token || !!localStorage.getItem('token');
    }
    
    if (!hasToken) {
      await loginAndGetProgress()
    }
    
    await request({
      url: '/api/game/progress',
      method: 'POST',
      data: {
        gameType: GameTypeEnum.FRUIT_PICKING,
        levelNum
      }
    })
  } catch {
    // API 不可用时保留当前内存进度
  }
}

export interface RankItem {
  rank: number
  userId: number
  nickname: string
  avatarUrl: string
  levelNum: number
  isMe: boolean
}

export interface RankResponse {
  myRank: RankItem | null
  list: RankItem[]
}

export const fetchRank = async (): Promise<RankResponse> => {
  try {
    const res = await request<RankResponse>({
      url: '/api/game/rank',
      method: 'POST',
      data: {
        gameType: GameTypeEnum.FRUIT_PICKING
      }
    })
    return res.data
  } catch (e) {
    console.error("Fetch rank failed:", e)
    return { myRank: null, list: [] }
  }
}

export const hasUserProfile = (): boolean => {
  try {
    if (platform) {
      return !!platform.getStorageSync('hasProfile');
    }
    return localStorage.getItem('hasProfile') === 'true';
  } catch {
    return false;
  }
}

const PROFILE_KEY = 'profile'

export const getCachedProfile = (): { nickname: string; avatarUrl: string } | null => {
  try {
    if (platform) {
      const raw = platform.getStorageSync(PROFILE_KEY)
      return raw || null
    }
    const raw = localStorage.getItem(PROFILE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export interface ProfileUpdateResult {
  success: boolean
  message?: string
}

export const updateProfile = async (nickname: string, avatarUrl: string): Promise<ProfileUpdateResult> => {
  try {
    await request({
      url: '/api/game/profile',
      method: 'POST',
      data: { nickname, avatarUrl }
    })
    const data = { nickname, avatarUrl }
    if (platform) {
      platform.setStorageSync(PROFILE_KEY, data)
      platform.setStorageSync('hasProfile', true)
    } else {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(data))
      localStorage.setItem('hasProfile', 'true')
    }
    return { success: true }
  } catch (e) {
    console.error("Update profile failed:", e)
    const message = e instanceof Error
      ? e.message
      : ((e as { message?: string } | null)?.message || '保存失败，请重试')
    return { success: false, message }
  }
}

/** 
 * 消耗一次当天的分享奖励次数
 * 如果后端返回 HTTP 403 或者业务 code 表明超限，会进入 catch 或返回 false
 */
export const consumeShareCount = async (): Promise<{ success: boolean, isLimit: boolean }> => {
  try {
    const res = await request({
      url: '/api/game/share/consume',
      method: 'POST',
      data: {
        gameType: GameTypeEnum.FRUIT_PICKING
      }
    });
    const isLimit = res.data ? !!res.data.isLimit : false;
    return { success: res.code === 200, isLimit: isLimit };
  } catch (e: any) {
    console.error("Consume share count failed:", e);
    const isLimit = e.message && e.message.includes('上限');
    return { success: false, isLimit: !!isLimit };
  }
}
