import { Redirect, useLocalSearchParams } from 'expo-router';

export default function RetiredProjectWorkspaceRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/projects/[id]', params: { id } }} />;
}
