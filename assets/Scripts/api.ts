export enum GameTypeEnum {
  SCREW = 'SCREW'
}

export enum SourceEnum {
  WECHAT = 'WECHAT'
}

const BASE_URL = 'https://game.sniper.net.cn'

interface ApiResponse<T = any> {
  code: number
  data: T
  message?: string
}

declare const wx: any;

let token: string | null = null;
let currentLevel = 1;

try {
    if (typeof wx !== 'undefined') {
        token = wx.getStorageSync('token') || null;
    }
} catch (e) {}

const request = <T = any>(options: any): Promise<ApiResponse<T>> => {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.header || {})
    }
    
    if (typeof wx === 'undefined') {
        // Fallback for browser preview (Cocos dashboard)
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
      token = wx.getStorageSync('token') || null
    }
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    wx.request({
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
    
    if (typeof wx !== 'undefined') {
        const loginRes = await new Promise<any>((resolve, reject) => {
          wx.login({
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
        source: SourceEnum.WECHAT
      }
    })
    token = res.data.token
    if (token) {
        if (typeof wx !== 'undefined') {
            wx.setStorageSync('token', token)
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
    if (typeof wx !== 'undefined') {
        hasToken = !!token || !!wx.getStorageSync('token');
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
