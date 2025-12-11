# Contributing to Polymarket Sniper Bot

Thank you for your interest in contributing to Polymarket Sniper Bot! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them learn
- Focus on constructive feedback
- Respect different viewpoints and experiences

## Getting Started

### Prerequisites

- Node.js 18+
- Git
- A code editor (VS Code recommended)

### Development Setup

1. **Fork the repository**
   ```bash
   # Click the "Fork" button on GitHub
   ```

2. **Clone your fork**
   ```bash
   git clone https://github.com/your-username/polymarket-sniper-bot.git
   cd polymarket-sniper-bot
   ```

3. **Add upstream remote**
   ```bash
   git remote add upstream https://github.com/original-org/polymarket-sniper-bot.git
   ```

4. **Install dependencies**
   ```bash
   npm install
   ```

5. **Create a branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Making Changes

1. **Create a feature branch** from `main`
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write clean, readable code
   - Follow existing code style
   - Add comments for complex logic
   - Update documentation as needed

3. **Test your changes**
   ```bash
   npm run build
   npm run lint
   ```

4. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

### Commit Message Guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/) format:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

Examples:
```
feat: add balance validation before trade execution
fix: resolve mempool monitoring connection issues
docs: update README with new configuration options
refactor: extract constants to separate file
```

### Code Style

- **TypeScript**: Follow strict TypeScript best practices
- **Formatting**: Use Prettier (configured in project)
- **Linting**: Follow ESLint rules
- **Naming**: Use descriptive, camelCase for variables/functions, PascalCase for classes
- **Comments**: Add JSDoc comments for public APIs

### Running Linters

```bash
# Check for linting errors
npm run lint

# Auto-fix linting errors
npm run lint:fix

# Format code
npm run format
```

## Pull Request Process

1. **Update your fork**
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Push your changes**
   ```bash
   git push origin feature/your-feature-name
   ```

3. **Create a Pull Request**
   - Use a clear, descriptive title
   - Provide a detailed description of changes
   - Reference any related issues
   - Include screenshots if applicable

4. **PR Checklist**
   - [ ] Code follows project style guidelines
   - [ ] All linters pass
   - [ ] Documentation updated (if needed)
   - [ ] Changes tested locally
   - [ ] Commit messages follow guidelines

## Project Structure

```
src/
├── app/              # Application entry point
├── cli/              # CLI commands
├── config/           # Configuration
├── constants/        # Constants
├── domain/           # Domain models
├── errors/           # Error classes
├── infrastructure/   # External integrations
├── services/         # Business logic
└── utils/            # Utilities
```

## Areas for Contribution

- 🐛 **Bug Fixes**: Fix issues reported in GitHub Issues
- ✨ **Features**: Implement new features from the roadmap
- 📚 **Documentation**: Improve docs, add examples
- 🧪 **Testing**: Add unit tests, integration tests
- 🔧 **Refactoring**: Improve code quality and structure
- ⚡ **Performance**: Optimize existing code

## Reporting Issues

When reporting issues, please include:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, OS, etc.)
- Relevant logs or error messages
- Screenshots if applicable

## Feature Requests

For feature requests:

- Check if the feature already exists
- Explain the use case and benefits
- Provide implementation suggestions if possible
- Consider backward compatibility

## Questions?

- Open a GitHub Discussion
- Check existing Issues and PRs
- Review the documentation

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

---

Thank you for contributing! 🎉

