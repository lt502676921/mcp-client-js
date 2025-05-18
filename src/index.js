const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const OpenAI = require('openai');
const dotenv = require('dotenv');

dotenv.config(); // Load environment variables from .env

class MCPClient {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      timeout: 300000
    });
    this.client = new Client({
      name: 'mcp-javascript-client',
      version: '1.0.0',
    });
  }

  async connectToServer(serverScriptPath) {
    const isPython = serverScriptPath.endsWith('.py');
    const isJs = serverScriptPath.endsWith('.js');
    if (!isPython && !isJs) {
      throw new Error('Server script must be a .py or .js file');
    }

    const command = isPython ? 'python' : 'node';
    const serverParams = {
      command,
      args: [serverScriptPath],
      timeout: 300000
    };

    const transport = new StdioClientTransport(serverParams);
    await this.client.connect(transport);

    // List available tools
    const response = await this.client.listTools();
    const toolNames = response.tools.map(tool => tool.name);
    console.log('\nConnected to server with tools:', toolNames);
  }

  async processQuery(query) {
    const messages = [
      {
        role: 'user',
        content: query,
      },
    ];

    const response = await this.client.listTools();
    const availableTools = response.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required,
        },
      },
    }));

    // Initial OpenAI API call
    let openaiResponse = await this.openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages,
      tools: availableTools,
      enable_thinking: false,
    });

    let finalText = [];
    let responseMessage = openaiResponse.choices[0].message;
    const toolResults = [];

    // Handle tool calls
    if (responseMessage.tool_calls) {
      for (const toolCall of responseMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        console.log(`Calling tool: ${toolName} with args: ${JSON.stringify(toolArgs)}`);

        // Execute tool call
        const toolResult = await this.client.callTool({ name: toolName, arguments: toolArgs });
        toolResults.push({ call: toolName, result: toolResult });
        finalText.push(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);

        console.log(`Tool ${toolName} result:`, toolResult);

        // Append tool result to messages
        messages.push({
          role: 'assistant',
          content: responseMessage.content || '',
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify(toolResult.content),
          tool_call_id: toolCall.id,
        });

        // Get next response from OpenAI
        openaiResponse = await this.openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          messages,
          tools: availableTools,
          enable_thinking: false,
        });

        finalText.push(openaiResponse.choices[0].message.content);
      }
    } else {
      finalText.push(responseMessage.content);
    }

    return finalText.join('\n');
  }

  async chatLoop() {
    console.log('\nMCP Client Started!');
    console.log("Type your queries or 'quit' to exit.");

    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    while (true) {
      const query = await new Promise(resolve => {
        readline.question('> ', resolve);
      });

      if (query.toLowerCase() === 'quit') {
        break;
      }

      try {
        const response = await this.processQuery(query);
        console.log(response);
      } catch (error) {
        console.error('Error processing query:', error.message);
      }
    }

    readline.close();
  }

  async cleanup() {
    if (this.client) {
      await this.client.close();
    }
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log('Usage: node src/index.js <path_to_server_script>');
    process.exit(1);
  }

  const client = new MCPClient();
  const serverPath = process.argv[2] || '../weather/weather.py'; // Default to weather server
  try {
    await client.connectToServer(serverPath);
    await client.chatLoop();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await client.cleanup();
  }
}

main();
