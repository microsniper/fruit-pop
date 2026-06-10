export enum GameTypeEnum {
  SCREW = 'SCREW'
}

export enum SourceEnum {
  WECHAT = 'WECHAT',
  DOUYIN = 'DOUYIN'
}

const BASE_URL = 'https://test.game.sniper.net.cn'

interface ApiResponse<T = any> {
  code: number
  data: T
  message?: string
}

declare const wx: any;
declare const tt: any;

const platform = typeof tt !== 'undefined' ? tt : (typeof wx !== 'undefined' ? wx : null);
const currentSource = typeof tt !== 'undefined' ? SourceEnum.DOUYIN : (typeof wx !== 'undefined' ? SourceEnum.WECHAT : SourceEnum.WECHAT);

let token: string | null = null;
let currentLevel = 1;

try {
    if (platform) {
        token = platform.getStorageSync('token') || null;
    }
} catch (e) {}

const request = <T = any>(options: any): Promise<ApiResponse<T>> => {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.header || {})
    }
    
    if (!platform) {
        if (!token) {
            token = localStorage.getItem('token') || null;
        }
        if (token) {
            headers['Authorization'] = `Bearer ${token}`
        }
        
        fetch(BASE_URL + options.url, {
            method: options.method || 'GET',
            headers: headers,
            body: options.data ? JSON.stringify(options.data) : undefined
        })
        .then(res => res.json())
        .then(data => {
            if (data.code === 200) {
                resolve(data)
            } else {
                reject(new Error(data.message || '请求失败'))
            }
        })
        .catch(reject);
        return;
    }

    if (!token) {
      token = platform.getStorageSync('token') || null
    }
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    platform.request({
      ...options,
      url: BASE_URL + options.url,
      header: headers,
      success: (res: any) => {
        const data = res.data as ApiResponse<T>
        if (data.code === 200) {
          resolve(data)
        } else {
          reject(new Error(data.message || '请求失败'))
        }
      },
      fail: (err: any) => {
        reject(err)
      }
    })
  })
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
    }

    const res = await request<{ token: string; source: SourceEnum; progress: { gameType: GameTypeEnum; levelNum: number } }>({
      url: '/api/game/login',
      method: 'POST',
      data: {
        code: code,
        gameType: GameTypeEnum.SCREW,
        source: currentSource
      }
    })
    token = res.data.token
    if (token) {
        if (platform) {
            platform.setStorageSync('token', token)
        } else {
            localStorage.setItem('token', token);
        }
    }

    const serverLevel = res.data.progress?.levelNum || 1
    setLocalLevel(serverLevel)
    return serverLevel
  } catch (e) {
    console.error("Login failed:", e);
    return getLocalLevel()
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
        gameType: GameTypeEnum.SCREW,
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
        gameType: GameTypeEnum.SCREW
      }
    })
    return res.data
  } catch (e) {
    console.error("Fetch rank failed:", e)
    return { myRank: null, list: [] }
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

export const updateProfile = async (nickname: string, avatarUrl: string): Promise<boolean> => {
  try {
    await request({
      url: '/api/game/profile',
      method: 'POST',
      data: { nickname, avatarUrl }
    })
    const data = { nickname, avatarUrl }
    if (platform) {
      platform.setStorageSync(PROFILE_KEY, data)
    } else {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(data))
    }
    return true
  } catch (e) {
    console.error("Update profile failed:", e)
    return false
  }
}
