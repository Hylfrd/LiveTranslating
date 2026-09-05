import { AlibabaQwenAudioAdapter } from "./alibaba-qwen-audio.js";
import { AlibabaQwen3Adapter } from "./alibaba-qwen3.js";
import { MockCloudAsrAdapter } from "./mock.js";
import { TencentCloudAsrAdapter } from "./tencent.js";
import { VolcengineAsrAdapter } from "./volcengine.js";
import type { CloudAsrAdapter, CloudAsrProviderId } from "../types.js";

export function createCloudAsrAdapter(provider: CloudAsrProviderId): CloudAsrAdapter {
  switch (provider) {
    case "alibaba-qwen-audio": return new AlibabaQwenAudioAdapter();
    case "alibaba-qwen3": return new AlibabaQwen3Adapter();
    case "tencent": return new TencentCloudAsrAdapter();
    case "volcengine": return new VolcengineAsrAdapter();
    case "mock": return new MockCloudAsrAdapter();
  }
}
