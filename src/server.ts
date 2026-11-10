import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fetch from "node-fetch";
import { z } from "zod";

// --- Interfaces de Tipagem ---
interface RequestBody {
  audioBase64: string;
  prompt?: string;
}

interface WSMessage {
  event: "data" | "stop";
  data?: string;
  prompt?: string;
}

interface OllamaChunk {
  message?: {
    content?: string;
  };
}

// 1. Inicialização do Servidor MCP (Transporte STDIO)
const mcpServer = new Server(
  { name: "ollama-omni-mcp-server-ts", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Registrar ferramenta MCP padrão para o cliente (Cursor, Claude Desktop, etc.)
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "processar_audio",
    description: "Envia um áudio completo em Base64 para o modelo lfm3-omni:2b no Ollama",
    inputSchema: {
      type: "object",
      properties: {
        audioBase64: { type: "string", description: "Áudio codificado em Base64" },
        prompt: { type: "string", description: "Instrução para processar o áudio" }
      },
      required: ["audioBase64"]
    }
  }]
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "processar_audio") throw new Error("Ferramenta não encontrada");
  
  const args = request.params.arguments as unknown as RequestBody;
  if (!args || !args.audioBase64) throw new Error("Parâmetro 'audioBase64' é obrigatório.");

  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "lfm3-omni:2b",
      messages: [{ role: "user", content: args.prompt || "Transcreva:", audios: [args.audioBase64] }],
      stream: false
    })
  });

  const data = (await response.json()) as any;
  return { content: [{ type: "text", text: data.message?.content || "" }] };
});

// 2. Inicialização do Servidor de Rede (Fastify + REST + WebSockets)
const fastify: FastifyInstance = Fastify({ logger: true });
await fastify.register(fastifyWebsocket);

// --- Endpoint REST: HTTP Chunked/Streaming ---
fastify.post<{ Body: RequestBody }>("/audio/stream", async (request, reply) => {
  const { audioBase64, prompt } = request.body;
  
  if (!audioBase64) {
    return reply.status(400).send({ error: "O campo 'audioBase64' é obrigatório no corpo do JSON." });
  }

  const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "lfm3-omni:2b",
      messages: [{ role: "user", content: prompt || "Responda:", audios: [audioBase64] }],
      stream: true // Exige streaming nativo do Ollama
    })
  });

  if (!ollamaResponse.body) {
    return reply.status(500).send({ error: "Falha ao ler o fluxo de stream do Ollama." });
  }

  reply.raw.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });
  
  ollamaResponse.body.on("data", (chunk: Buffer) => {
    try {
      const json = JSON.parse(chunk.toString()) as OllamaChunk;
      if (json.message?.content) {
        reply.raw.write(json.message.content);
      }
    } catch (e) {
      // Ignora quebras temporárias na segmentação do JSON incremental
    }
  });

  ollamaResponse.body.on("end", () => reply.raw.end());
});

// --- Endpoint WebSockets: Streaming Bidirecional de Áudio/Texto ---
fastify.route({
  method: "GET",
  url: "/audio/ws",
  handler: (_req, reply) => reply.send({ error: "Use conexões WebSocket válidas neste endpoint" }),
  wsHandler: (connection) => {
    let audioChunks: string[] = [];

    connection.socket.on("message", async (message: Buffer) => {
      try {
        const payload = JSON.parse(message.toString()) as WSMessage;

        if (payload.event === "data" && payload.data) {
          // Coleta os pedaços de áudio em Base64 enviados continuamente pelo cliente
          audioChunks.push(payload.data);
        }

        if (payload.event === "stop") {
          connection.socket.send(JSON.stringify({ status: "processing", message: "Áudio consolidado. Enviando ao Ollama..." }));
          
          const fullAudioBase64 = audioChunks.join("");
          const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "lfm3-omni:2b",
              messages: [{ role: "user", content: payload.prompt || "Responda:", audios: [fullAudioBase64] }],
              stream: true
            })
          });

          if (!ollamaResponse.body) {
            connection.socket.send(JSON.stringify({ event: "error", error: "Erro de stream com o modelo." }));
            return;
          }

          ollamaResponse.body.on("data", (chunk: Buffer) => {
            try {
              const json = JSON.parse(chunk.toString()) as OllamaChunk;
              if (json.message?.content) {
                // Devolve os blocos de texto gerados em tempo real ao cliente via WS
                connection.socket.send(JSON.stringify({ event: "text_chunk", data: json.message.content }));
              }
            } catch (e) {}
          });

          ollamaResponse.body.on("end", () => {
            connection.socket.send(JSON.stringify({ event: "done" }));
            audioChunks = []; // Esvazia o buffer de áudio para a próxima gravação
          });
        }
      } catch (err: any) {
        connection.socket.send(JSON.stringify({ event: "error", error: err.message }));
      }
    });
  }
});

// 3. Inicialização Combinada dos Transportes (STDIO + HTTP REST/WS)
const start = async () => {
  // Conecta o servidor MCP ao transporte padrão STDIO do Node
  const stdioTransport = new StdioServerTransport();
  mcpServer.connect(stdioTransport).catch(console.error);

  // Inicializa o servidor Fastify HTTP e WebSocket na porta 3001
  try {
    await fastify.listen({ port: 3001, host: "0.0.0.0" });
    console.log("🚀 Servidor MCP Omni (TS) rodando em http://localhost:3001");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
