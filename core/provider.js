// Provider contract. Implementations receive a runtime adapter, not Node APIs.
class Provider {
  async chat (_request) {
    throw new Error('Provider.chat() is not implemented')
  }

  async *stream (_request, _signal) {
    throw new Error('Provider.stream() is not implemented')
  }

  async models (_name = '') {
    throw new Error('Provider.models() is not implemented')
  }
}

module.exports = Provider
