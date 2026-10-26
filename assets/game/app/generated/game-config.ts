// 自动生成：启动选择与渠道参数均来自 project-settings/game-config.json。
import { freezeGameConfig } from '../../../framework/app/game-config';
/** 当前运行配置；地址与 SDK 参数在运行期间保持不变。 */
export const gameConfig = freezeGameConfig({
    appVersion: '1.0.0',
    channel: 'wechat_self',
    mode: 'release',
    environment: 'dev',
    channelName: '微信 · 自发行',
    platform: 'wechat',
    buildTargets: ['wechatgame'],
    platformAppId: 'wx18786e6d01c6cc22',
    diagnostics: {
        logLevel: 'warn',
        showStats: false,
    },
    endpoints: {
        apiBaseUrl: '',
        resourceBaseUrl: '',
    },
    sdk: {
        integration: 'platform',
        ads: {
            revive: '',
            double_reward: '',
        },
        share: {
            default: {
                title: '一起玩游戏',
            },
        },
        parameters: {},
        timeoutMs: 10000,
    },
    previewMockSdk: false,
    configHash: 'e25ccccd23fec3ef658249735bdb203e105adfcce4d2a56f11eb20bfe5aec1c9',
});
