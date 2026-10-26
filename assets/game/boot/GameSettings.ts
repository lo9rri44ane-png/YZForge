import { _decorator } from 'cc';
import { AppSettings } from '../../framework/app/app-settings';
import type { GameConfig } from '../../framework/app/game-config';
import { gameConfig } from '../app/generated/game-config';
const { ccclass, disallowMultiple, menu } = _decorator;

/** 项目配置入口。修改 project-settings/game-config.json 后运行 generate；预览和构建前执行 check。 */
@ccclass('game.GameSettings')
@disallowMultiple
@menu('YZForge/游戏设置')
export class GameSettings extends AppSettings {
    /** 返回生成器冻结的运行快照；组件不再保存渠道、模式或环境。 */
    resolve(): GameConfig {
        return gameConfig;
    }
}
