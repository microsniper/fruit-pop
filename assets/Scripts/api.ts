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
const originalWxRequest = typeof wx !== 'undefined' && wx.request ? wx.request.bind(wx) : null;
const originalWxLogin = typeof wx !== 'undefined' && wx.login ? wx.login.bind(wx) : null;
const currentSource = typeof tt !== 'undefined' ? SourceEnum.DOUYIN : (typeof wx !== 'undefined' ? SourceEnum.WECHAT : SourceEnum.WECHAT);

const SECRET_KEY = "X9vP2xL5mN8qR1sT4wY7zB0cJ3fH6gD9";

let token: string | null = null;
let currentLevel = 1;
let dailyRewardClaimable = false;
let newUserThisLogin = false;

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
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          fetch(BASE_URL + options.url, {
              method: options.method || 'GET',
              headers: headers,
              body: options.data ? JSON.stringify(options.data) : undefined,
              signal: controller.signal
          })
          .then(async res => {
              clearTimeout(timeoutId);
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
          .catch(err => {
              clearTimeout(timeoutId);
              if (err.name === 'AbortError') {
                  reject(new Error('请求超时'));
              } else {
                  reject(err);
              }
          });
          return;
      }

      const reqFunc = originalWxRequest || platform.request.bind(platform);
      reqFunc({
        ...options,
        url: BASE_URL + options.url,
        header: headers,
        timeout: 15000,
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
    // 已登录（token 已有）：跳过重复登录，直接返回本地进度
    if (token) {
      console.log('[API] already logged in, skip login');
      return getLocalLevel();
    }
    let code = "browser_mock_code";
    
    if (platform) {
        const loginFunc = originalWxLogin || platform.login.bind(platform);
        const loginRes = await new Promise<any>((resolve, reject) => {
          loginFunc({
            success: resolve,
            fail: reject
          })
        });
        code = loginRes.code;
        console.log('[API] wx.login success, code:', code);
    }

    const res = await request<{ token: string; openid: string; source: SourceEnum; hasProfile: boolean; isNewUser: boolean; dailyRewardClaimable: boolean; regionId: number | null; progress: { gameType: GameTypeEnum; levelNum: number } }>({
      url: '/api/game/login',
      method: 'POST',
      data: {
        code: code,
        gameType: GameTypeEnum.FRUIT_PICKING,
        source: currentSource
      }
    });
    console.log('[API] login response, levelNum:', res.data?.progress?.levelNum, 'hasProfile:', res.data?.hasProfile, 'isNewUser:', res.data?.isNewUser, 'dailyRewardClaimable:', res.data?.dailyRewardClaimable);
    token = res.data.token;
    dailyRewardClaimable = res.data?.dailyRewardClaimable ?? false;
    newUserThisLogin = res.data?.isNewUser ?? false;
    if (token) {
        if (platform) {
            platform.setStorageSync('token', token);
            platform.setStorageSync('hasProfile', res.data?.hasProfile);
            if (res.data?.isNewUser) {
                platform.setStorageSync('isNewUser', true);
            }
        } else {
            localStorage.setItem('token', token);
            localStorage.setItem('hasProfile', String(res.data?.hasProfile));
            if (res.data?.isNewUser) {
                localStorage.setItem('isNewUser', 'true');
            }
        }
    }
    // 存储 openid 供广告 SDK 使用
    if (res.data.openid) {
        if (platform) {
            platform.setStorageSync('openid', res.data.openid);
        } else {
            localStorage.setItem('openid', res.data.openid);
        }
    }

    // 已选地区ID回写本地（跨设备/重装后仍能记得）；后端为 null 就清本地
    setLocalRegionId(res.data?.regionId ?? null);

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
                const loginFunc = originalWxLogin || platform.login.bind(platform);
                const loginRes = await new Promise<any>((resolve, reject) => {
                    loginFunc({ success: resolve, fail: reject });
                });
                const res = await request<{ token: string; hasProfile: boolean; dailyRewardClaimable: boolean; progress: { levelNum: number } }>({
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
                dailyRewardClaimable = res.data?.dailyRewardClaimable ?? false;
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

// ========== 每日挑战（省份 PK） ==========

export interface DailyStatusResponse {
  cleared: boolean
  challengeDate: string
  /** 今日最快通关耗时（秒）；未通关或无有效计时为 null */
  bestSeconds: number | null
}

export interface DailyRankItem {
  rank: number
  regionId: number
  regionName: string
  clearCount: number
  isMe: boolean
}

export interface DailyRankResponse {
  myRank: DailyRankItem | null
  list: DailyRankItem[]
}

/** 检查 token，没有则先静默登录（与 saveProgress 同款模式） */
const ensureToken = async (): Promise<void> => {
  let hasToken = false;
  if (platform) {
    hasToken = !!token || !!platform.getStorageSync('token');
  } else {
    hasToken = !!token || !!localStorage.getItem('token');
  }
  if (!hasToken) {
    await loginAndGetProgress()
  }
}

/** 每日挑战状态：今天是否已通关（后端读不建行；失败返回 null 由调用方按未通关兜底） */
export const getDailyStatus = async (): Promise<DailyStatusResponse | null> => {
  try {
    await ensureToken()
    const res = await request<DailyStatusResponse>({
      url: '/api/game/daily/status',
      method: 'POST',
      data: { gameType: GameTypeEnum.FRUIT_PICKING }
    })
    return res.data
  } catch (e) {
    console.error('[API] getDailyStatus failed:', e)
    return null
  }
}

/** 每日挑战通关上报响应：本次耗时 / 今日最快耗时（秒），计时不可信时为 null */
export interface DailyClearResponse {
  currentSeconds: number | null
  bestSeconds: number | null
  newRecord: boolean
}

/**
 * 每日挑战通关上报：startAt 为前端计时的挑战开始毫秒时间戳。
 * 一人一天一行，重复挑战更快则后端刷新起止时间，所以每次通关都要报。
 * 返回本次与今日最快耗时，通关页直接用。
 */
export const saveDailyClear = async (startAt: number): Promise<DailyClearResponse | null> => {
  try {
    await ensureToken()
    const res = await request<DailyClearResponse>({
      url: '/api/game/daily/clear',
      method: 'POST',
      data: { gameType: GameTypeEnum.FRUIT_PICKING, startAt }
    })
    return res.data
  } catch (e) {
    console.error('[API] saveDailyClear failed:', e)
    return null
  }
}

/** 每日求助好友次数响应 */
export interface DailyHelpResponse {
  used: number
  max: number
  remaining: number
}

/** 每日求助好友状态：今日已用次数/上限/剩余 */
export const getDailyHelpStatus = async (): Promise<DailyHelpResponse | null> => {
  try {
    await ensureToken()
    const res = await request<DailyHelpResponse>({
      url: '/api/game/daily-help/status',
      method: 'POST',
      data: { gameType: GameTypeEnum.FRUIT_PICKING }
    })
    return res.data
  } catch (e) {
    console.error('[API] getDailyHelpStatus failed:', e)
    return null
  }
}

/** 每日求助好友使用：+1，返回最新次数 */
export const useDailyHelp = async (): Promise<DailyHelpResponse | null> => {
  try {
    await ensureToken()
    const res = await request<DailyHelpResponse>({
      url: '/api/game/daily-help/use',
      method: 'POST',
      data: { gameType: GameTypeEnum.FRUIT_PICKING }
    })
    return res.data
  } catch (e) {
    console.error('[API] useDailyHelp failed:', e)
    return null
  }
}

/** 每日挑战省份榜（榜单 UI 后续接入，接口先备） */
export const getDailyRank = async (): Promise<DailyRankResponse | null> => {
  try {
    await ensureToken()
    const res = await request<DailyRankResponse>({
      url: '/api/game/daily/rank',
      method: 'POST',
      data: { gameType: GameTypeEnum.FRUIT_PICKING }
    })
    return res.data
  } catch (e) {
    console.error('[API] getDailyRank failed:', e)
    return null
  }
}

// ========== 游戏配置 ==========

export interface GameConfigWeights {
  temp: number
  click: number
  block: number
}

export interface GameConfigCapacityRange {
  max: number
  w3?: number
  w4?: number
  w5?: number
  w6?: number
}

export interface GameConfigToolCosts {
  addBasket: number
  clearTray: number
  smashPlate: number
}

export interface GameConfig {
  challengeInterval: number
  normalWeights: GameConfigWeights
  challengeWeights: GameConfigWeights
  boxCapacity: GameConfigCapacityRange[]
  toolCosts: GameConfigToolCosts
  dailyLoginReward: number
  newUserReward: number
  /** 每日挑战批次计划（按关号分组）：levels.关号.batches=[{colors水果颜色数,layers层数}] */
  dailyWavePlan?: Record<string, { batches?: DailyWavePlanBatch[] }>
  /** 每日挑战每层板子数（按关号分组再按批）：maxPlates 缺省=铺满；rectFirst/shapeFirst=方板/异形保底块数 */
  dailyWavePlates?: Record<string, { batches?: DailyWavePlatesBatch[] }>
  /** 每日挑战果篮孔数分布权重 */
  dailyBoxCapacity?: DailyBoxCapacity
  /** 每日挑战果篮刷新颜色权重 */
  dailyChallengeWeights?: GameConfigWeights
  /** 每日挑战层流规则：遮挡翻彩/补层阈值 */
  dailyLayerRules?: DailyLayerRules
}

export interface DailyWavePlanBatch {
  colors?: number
  layers?: number
}

export interface DailyWavePlatesBatch {
  maxPlates?: number
  rectFirst?: number
  shapeFirst?: number
  /** 长条形大板保底块数（plate_bar，宽扁横条横向5孔；缺省/0=不出现） */
  stripFirst?: number
}

export interface DailyBoxCapacity {
  w3?: number
  w4?: number
  w5?: number
  w6?: number
}

export interface DailyLayerRules {
  unburyRatio?: number
  refillRatio?: number
}

/** 缓存的游戏配置 */
let cachedGameConfig: GameConfig | null = null

export const fetchGameConfig = async (): Promise<GameConfig> => {
  try {
    if (cachedGameConfig) {
      return cachedGameConfig
    }

    let hasToken = false;
    if (platform) {
        hasToken = !!token || !!platform.getStorageSync('token');
    } else {
        hasToken = !!token || !!localStorage.getItem('token');
    }
    if (!hasToken) {
      await loginAndGetProgress()
    }

    const res = await request<GameConfig>({
      url: '/api/game/config',
      method: 'POST',
      data: {
        gameType: GameTypeEnum.FRUIT_PICKING
      }
    })
    cachedGameConfig = res.data
    console.log('[API] game config loaded:', cachedGameConfig)
    return cachedGameConfig
  } catch (e) {
    console.error('[API] fetch game config failed, using default:', e)
    return getDefaultGameConfig()
  }
}

/** 兜底：代码内置默认配置 */
export const getDefaultGameConfig = (): GameConfig => {
  return {
    challengeInterval: 5,
    normalWeights: { temp: 20, click: 30, block: 60 },
    challengeWeights: { temp: 10, click: 20, block: 60 },
    toolCosts: { addBasket: 20, clearTray: 20, smashPlate: 20 },
    dailyLoginReward: 200,
    newUserReward: 1000,
    boxCapacity: [
      { max: 6,  w3: 100 },
      { max: 11, w3: 85,  w4: 15 },
      { max: 16, w3: 65,  w4: 35 },
      { max: 21, w3: 50,  w4: 35,  w5: 15 },
      { max: 27, w3: 40,  w4: 35,  w5: 25 },
      { max: 35, w3: 25,  w4: 35,  w5: 30,  w6: 10 },
      { max: 45, w3: 15,  w4: 35,  w5: 35,  w6: 15 },
      { max: 999, w3: 10, w4: 30,  w5: 35,  w6: 25 }
    ]
  }
}

/** 获取当前缓存的游戏配置（不发起网络请求） */
export const getGameConfig = (): GameConfig => {
  return cachedGameConfig || getDefaultGameConfig()
}

/** 今日是否可领取每日登录奖励 */
export const isDailyRewardClaimable = (): boolean => dailyRewardClaimable;

/** 本次登录是否是新用户（仅创建用户的那次登录为 true，用于新人见面礼） */
export const isNewUserThisLogin = (): boolean => newUserThisLogin;

/** 领取每日登录奖励 */
export const claimDailyReward = async (): Promise<{ success: boolean; amount: number }> => {
  const res = await request<{ success: boolean; amount: number }>({
    url: '/api/game/daily-reward/claim',
    method: 'POST'
  })
  return res.data
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
/**
 * 埋点上报（异步，不等待结果）
 */
export const reportEvent = (scene: string) => {
  request({
    url: '/api/game/event/report',
    method: 'POST',
    data: { scene }
  }).catch(() => {
    // 埋点失败不影响游戏
  });
}

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

// ========== 地区选择 ==========

export interface RegionItem {
  id: number
  name: string
}

/** 本地地区ID 键（存 region.id，没选过为空） */
const REGION_ID_KEY = 'userRegionId'

/** 回写本地地区ID：登录后用后端值同步，null 则清除 */
export const setLocalRegionId = (regionId: number | null) => {
  try {
    if (regionId == null) {
      if (platform) platform.removeStorageSync(REGION_ID_KEY)
      else localStorage.removeItem(REGION_ID_KEY)
      return
    }
    if (platform) platform.setStorageSync(REGION_ID_KEY, String(regionId))
    else localStorage.setItem(REGION_ID_KEY, String(regionId))
  } catch (e) {}
}

/** 读本地地区ID，没选过返回 null（每日挑战 gate 用它判断要不要弹选地区） */
export const getLocalRegionId = (): number | null => {
  try {
    const raw = platform ? platform.getStorageSync(REGION_ID_KEY) : localStorage.getItem(REGION_ID_KEY)
    const n = parseInt(String(raw), 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch (e) {
    return null
  }
}

/** 拉地区字典列表（后端缓存优先），失败返回空数组 */
export const fetchRegionList = async (): Promise<RegionItem[]> => {
  try {
    const res = await request<RegionItem[]>({
      url: '/api/game/region/list',
      method: 'POST',
      data: {}
    })
    return res.data || []
  } catch (e) {
    console.error('Fetch region list failed:', e)
    return []
  }
}

/** 保存用户选的地区（存 region.id）；成功同步本地 */
export const saveUserRegion = async (regionId: number): Promise<boolean> => {
  try {
    await request({
      url: '/api/game/region',
      method: 'POST',
      data: { regionId }
    })
    setLocalRegionId(regionId)
    return true
  } catch (e) {
    console.error('Save user region failed:', e)
    return false
  }
}
