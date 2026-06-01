export enum GameTypeEnum {
  SCREW = 'SCREW'
}

export enum SourceEnum {
  WECHAT = 'WECHAT',
  DOUYIN = 'DOUYIN'
}

const BASE_URL = 'https://game.sniper.net.cn'

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
