import express, { Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Validate config before starting
loadConfig();

const app = express();
app.use(express.json());

// Store active MCP process and message handler
let mcpProcess: ReturnType<typeof spawn> | null = null;
let messageQueue: Array<{ id: string; message: string; resolve: (data: unknown) => void; reject: (err: unknown) => void }> = [];
let messageCounter = 0;

/**
 * Start the MCP server as a child process
 */
function startMCPServer() {
  return new Promise<void>((resolve, reject) => {
    const indexPath = path.join(__dirname, 'index.js');
    
    mcpProcess = spawn('node', [indexPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    });

    if (!mcpProcess.stdin || !mcpProcess.stdout) {
      return reject(new Error('Failed to initialize stdio streams'));
    }

    let buffer = '';

    mcpProcess.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      
      // Process complete JSON-RPC messages
      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            
            // Find matching request
            const pendingRequest = messageQueue.find(m => m.id === message.id);
            if (pendingRequest) {
              messageQueue = messageQueue.filter(m => m.id !== message.id);
              pendingRequest.resolve(message);
            }
          } catch (e) {
            console.error('Failed to parse MCP response:', line, e);
          }
        }
      }
    });

    mcpProcess.on('error', reject);
    mcpProcess.on('exit', (code) => {
      console.error(`MCP process exited with code ${code}`);
      mcpProcess = null;
    });

    // Give the process time to initialize
    setTimeout(resolve, 500);
  });
}

/**
 * Send a message to the MCP server and wait for response
 */
async function callMCPTool(toolName: string, toolInput: Record<string, unknown>) {
  if (!mcpProcess?.stdin) {
    throw new Error('MCP server is not running');
  }

  const id = (++messageCounter).toString();
  
  const jsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: toolInput,
    },
  };

  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      messageQueue = messageQueue.filter(m => m.id !== id);
      reject(new Error(`Tool call timeout for ${toolName}`));
    }, 30000);

    messageQueue.push({
      id,
      message: JSON.stringify(jsonRpcRequest),
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    mcpProcess!.stdin!.write(JSON.stringify(jsonRpcRequest) + '\n');
  });
}

/**
 * HTTP endpoints
 */

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', mcp: mcpProcess ? 'running' : 'stopped' });
});

// Call a tool
app.post('/api/tools/:toolName', async (req: Request, res: Response) => {
  try {
    const { toolName } = req.params;
    const toolInput = req.body;

    const result = await callMCPTool(toolName, toolInput);
    res.json(result);
  } catch (error) {
    console.error('Tool call error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// List tools (proxy to MCP)
app.get('/api/tools', async (req: Request, res: Response) => {
  try {
    const result = await callMCPTool('tools/list', {});
    res.json(result);
  } catch (error) {
    console.error('Tools list error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Start server
(async () => {
  try {
    console.log('Starting MCP server...');
    await startMCPServer();
    console.log('MCP server started');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`HTTP server listening on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`API endpoint: http://localhost:${PORT}/api/tools/:toolName`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (mcpProcess) {
    mcpProcess.kill();
  }
  process.exit(0);
});
