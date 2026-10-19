import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  PlayerActionRequest,
  PlayerActionResult,
  PlayerWindowAction,
  PlayerWindowClosed,
  PlayerWindowState,
} from "../domain/playerWindow";

const STATE_EVENT = "player-window-state";
const ACTION_EVENT = "player-window-action";
const RESULT_EVENT = "player-window-result";
const CLOSED_EVENT = "player-window-closed";
const CLOSE_ERROR_EVENT = "player-window-close-error";

/** 同一应用内的播放窗口通信；只传展示状态和用户意图，不复制播放源。 */
export class PlayerWindowService {
  /** 订阅展示快照；返回注销函数，供组件卸载时释放监听。 */
  listenState(handler: (state: PlayerWindowState) => void): Promise<UnlistenFn> {
    return listen<PlayerWindowState>(STATE_EVENT, ({ payload }) => handler(payload));
  }

  /** 主窗口订阅用户操作；处理方须回传相同 id 的实际执行结果。 */
  listenActions(handler: (request: PlayerActionRequest) => void): Promise<UnlistenFn> {
    return listen<PlayerActionRequest>(ACTION_EVENT, ({ payload }) => handler(payload));
  }

  /** 监听原生关闭完成事件，避免主窗口保留已销毁的播放状态。 */
  listenClosed(handler: (result: PlayerWindowClosed) => void): Promise<UnlistenFn> {
    return listen<PlayerWindowClosed>(CLOSED_EVENT, ({ payload }) => handler(payload));
  }

  /** 原生关闭失败时接收错误；失败窗口仍保留，供用户重试或结束应用。 */
  listenCloseError(handler: (result: PlayerWindowClosed) => void): Promise<UnlistenFn> {
    return listen<PlayerWindowClosed>(CLOSE_ERROR_EVENT, ({ payload }) => handler(payload));
  }

  /** 将不含媒体地址的状态定向发送到当前播放器控件。 */
  publishState(state: PlayerWindowState): Promise<void> {
    return emitTo("video-controls", STATE_EVENT, state);
  }

  /** 把命令的实际结果发回视频窗口；失败保持可见，不制造成功状态。 */
  reply(result: PlayerActionResult): Promise<void> {
    return emitTo("video-controls", RESULT_EVENT, result);
  }

  /**
   * 执行视频窗口中的用户操作，等待主窗口处理完成。
   * @param action 用户意图；跳转与音量仍由 Rust 再次校验。
   * @returns 主窗口已完成操作；超时、IPC 或播放错误均拒绝 Promise。
   */
  async perform(action: PlayerWindowAction): Promise<void> {
    const id = crypto.randomUUID();
    let unlisten: UnlistenFn | undefined;
    let timeout: number | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        // 先监听结果再发送，防止快速完成的暂停命令先于监听注册返回。
        void listen<PlayerActionResult>(RESULT_EVENT, ({ payload }) => {
          if (payload.id !== id) return;
          if (payload.error) reject(new Error(payload.error));
          else resolve();
        }).then((remove) => {
          unlisten = remove;
          timeout = window.setTimeout(() => reject(new Error("播放操作响应超时，请重试")), 45_000);
          return emitTo("main", ACTION_EVENT, { id, action } satisfies PlayerActionRequest);
        }).catch(reject);
      });
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      unlisten?.();
    }
  }

  /** 把正在播放的视频窗口带回前台。 */
  show(): Promise<void> {
    return invoke("show_video_window");
  }

  /** 切换当前视频窗口全屏；返回切换后的全屏状态。 */
  toggleFullscreen(): Promise<boolean> {
    return invoke<boolean>("toggle_video_fullscreen");
  }

  /** 退出全屏；窗口已经处于普通模式时保持原状。 */
  exitFullscreen(): Promise<void> {
    return invoke("exit_video_fullscreen");
  }
}
