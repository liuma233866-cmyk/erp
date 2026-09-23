// 从 server.js 拆出的路由注册表（ai 域）。

function createAiRoutes(deps) {
  const { aiConfigModule, aiImagePromptsModule, aiImageTasksModule, aiMainModule } = deps;
  return [
    {
      matches: (pathname, method) => pathname.startsWith("/api/ai/models"),
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const handled = await aiConfigModule.handleRequest(req, res, url, auditBase);
            return handled;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/ai/image-prompts"),
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const handled = await aiImagePromptsModule.handleRequest(req, res, url, auditBase);
            return handled;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/ai/image-tasks"),
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const handled = await aiImageTasksModule.handleRequest(req, res, url, auditBase);
            return handled;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/ai/chat",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const handled = await aiMainModule.handleRequest(req, res, url, auditBase);
            return handled;
      }
    },
  ];
}

module.exports = { createAiRoutes };
