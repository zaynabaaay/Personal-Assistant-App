# CocoaPods captures command output as binary data. Force it to UTF-8 so native
# dependency resolution works when the project path contains Unicode characters.
require 'cocoapods/executable'

module Pod
  module Executable
    class << self
      alias_method :execute_command_without_utf8, :execute_command

      def execute_command(executable, command, raise_on_failure = true)
        execute_command_without_utf8(executable, command, raise_on_failure)
          .force_encoding(Encoding::UTF_8)
      end
    end
  end
end
