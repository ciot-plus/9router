// TraeWork (Trae SOLO) provider registry entry.
// Reversed from official Trae client & wild-work:
//   Chat = POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
//   Auth = Authorization: Cloud-IDE-JWT <jwt>
//   Checkin = POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim
//   Usage = POST https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage
export default {
  id: "traework",
  alias: "traework",
  uiAlias: "traework",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"], // Only supports OAuth
  priority: 2,
  display: {
    name: "TraeWork",
    icon: "workspaces",
    color: "#00D2A0",
    textIcon: "TW",
    website: "https://work.trae.cn",
    notice: {
      signupUrl: "https://www.trae.cn",
    },
  },
  transport: {
    // Trae SOLO remote chat gateway endpoint
    baseUrl: "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
    forceStream: true,
    thinkingFormat: "openai",
    headers: {
      "X-Trae-Client-Type": "web",
      "X-Preferenced-Language": "zh-cn",
      "X-User-Region": "CN",
      "User-Agent": "Trae/0.1.52",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "Cloud-IDE-JWT",
    },
    usage: {
      url: "https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage",
    },
    checkin: {
      url: "https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim",
      statusUrl: "https://api.trae.cn/trae/api/v2/ug/checkin_credits/status",
    },
    modelsUrl: "https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param",
    pricingUrl: "https://work.trae.cn/api/remote/v1/models",
  },
  oauth: {
    clientId: "en1oxy7wnw8j9n",
    appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    platform: "SOLO_PC",
    ideVersion: "0.1.52",
    ideVersionCode: "20260811",
    pluginVersion: "2.3.73734",
    deviceBrand: "20Y5A002XX",
    osVersion: "Windows 10 Pro",
    authorizationUrl: "https://www.trae.cn/authorization",
    tokenUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    authCodeTokenUrl: "https://api.trae.cn/trae/api/v3/oauth/ExchangeToken",
    refreshUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    userInfoUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
    pollInterval: 1500,
    callbackPath: "/authorize",
  },
  models: [
    { id: "DeepSeek-V4-Flash-Official", name: "DeepSeek-V4-Flash 正式版" }
  ],
  features: {
    usage: true,
    checkin: true,
  },
};
