import { PostEditor } from '@/components/PostEditor';
import { postsApi } from '@/lib/posts';

export default async function PostPage({ params }: { params: { id: string } }) {
  const { data } = await postsApi.get(params.id);
  return (
    <article>
      <h1>{data.title}</h1>
      <PostEditor id={params.id} />
    </article>
  );
}
